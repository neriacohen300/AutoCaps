-- ==========================================================
-- AutoCaps - DaVinci Resolve Edition
-- כתוביות אוטומטיות, חיתוך שקט, ועריכת פודקאסט אוטומטית
-- ==========================================================
--
-- הערות חשובות לפני שימוש (קרא/י בבקשה):
--
-- 1. תכונת ה-UI (fu.UIManager) דורשת DaVinci Resolve STUDIO. בגרסת ה-Free
--    Blackmagic הסירו את ה-UIManager משלב v19.1, כך שהחלון לא ייפתח בגרסה
--    החינמית של Resolve 19.1 ומעלה.
--
-- 2. ל-DaVinci Resolve אין API רשמי ל"חיתוך" (Razor) של קליפים קיימים
--    בטיימליין כמו שיש לפרימייר (QE razor). לכן חיתוך השקט ועריכת הפודקאסט
--    כאן לא עורכים את הטיימליין הקיימת "במקום" - הם בונים טיימליין חדשה
--    (למשל "AutoCaps_NoSilence_121500") מהקליפים המקוריים, עם הזמנים
--    הנכונים. הטיימליין המקורית שלך נשארת שלמה ולא נפגעת - זו גם דרך
--    הפעולה הבטוחה היחידה שה-API מאפשר.
--
-- 3. נדרש קובץ FFmpeg בנתיב שמוגדר למטה (AUTOCAPS_FFMPEG_PATH) לצורך זיהוי
--    קטעי שקט. אותו FFmpeg שמותקן כבר עבור מנוע התמלול.
--
-- 4. נדרש פריסט רינדור בשם "Audio Only" בפרויקט (Deliver page) כדי לייצא
--    אודיו - בדיוק כמו בתכונת הכתוביות המקורית.
--
-- ==========================================================

local ffi = require("ffi")
local ui  = fu.UIManager
local disp = bmd.UIDispatcher(ui)

local resolve = Resolve()
local projectManager = resolve:GetProjectManager()
local project = projectManager:GetCurrentProject()

local IS_WINDOWS = (package.config:sub(1,1) == "\\")
local SEP = IS_WINDOWS and "\\" or "/"

-- ==========================================
-- נתיבים גלובליים (תואם למבנה התיקיות של גרסת פרימייר)
-- ==========================================

local localAppData = os.getenv("LOCALAPPDATA") or (os.getenv("HOME") or "")
local AUTOCAPS_DIR    = localAppData .. SEP .. "AutoCaps"
local AUTOCAPS_EXE    = AUTOCAPS_DIR .. SEP .. "backend" .. SEP .. (IS_WINDOWS and "transcription_engine.exe" or "transcription_engine")
local AUTOCAPS_FFMPEG = AUTOCAPS_DIR .. SEP .. "backend" .. SEP .. (IS_WINDOWS and "ffmpeg.exe" or "ffmpeg")
local AUTOCAPS_CUDA   = AUTOCAPS_DIR .. SEP .. "cuda"
local AUTOCAPS_MODELS = AUTOCAPS_DIR .. SEP .. "models"
local TEMP_DIR = os.getenv("TEMP") or os.getenv("TMPDIR") or "/tmp"

-- טעינת פונקציות מערכת הפעלה להרצה שקטה לחלוטין (בלי CMD קופץ!)
local shell32
if IS_WINDOWS then
    pcall(function()
        ffi.cdef[[
            void* ShellExecuteA(void* hwnd, const char* lpOperation, const char* lpFile, const char* lpParameters, const char* lpDirectory, int nShowCmd);
        ]]
    end)
    shell32 = ffi.load("shell32")
end

-- ==========================================
-- פונקציות עזר כלליות
-- ==========================================

local function pathExists(p)
    local f = io.open(p, "r")
    if f then f:close(); return true end
    return false
end

local function execute_silent_async(cmd, bat_path)
    if IS_WINDOWS and shell32 then
        local f = io.open(bat_path, "w")
        if f then
            f:write("@echo off\n" .. cmd .. "\n")
            f:close()
            shell32.ShellExecuteA(nil, "open", bat_path, nil, nil, 0)
        else
            os.execute('start /b "" cmd /c "' .. cmd .. '"')
        end
    else
        os.execute(cmd .. " &")
    end
end

local function waitForFile(filePath, timeoutSec)
    local timeout = timeoutSec
    while not pathExists(filePath) and timeout > 0 do
        bmd.wait(1)
        timeout = timeout - 1
    end
    return pathExists(filePath)
end

local function safeRemove(p)
    if p and pathExists(p) then pcall(os.remove, p) end
end

-- קריאת אחוזים וזמן שנותר מקובץ הלוג של מנוע התמלול בזמן אמת
local function read_log_progress(logPath)
    local f = io.open(logPath, "r")
    if not f then return nil, nil end
    local progress, eta = nil, nil
    for line in f:lines() do
        local progress_pct = line:match('"progress_pct"%s*:%s*([%d%.]+)')
        local eta_sec = line:match('"eta_sec"%s*:%s*([%d%.]+)')
        if progress_pct then progress = tonumber(progress_pct) end
        if eta_sec then eta = tonumber(eta_sec) end
    end
    f:close()
    return progress, eta
end

-- ==========================================
-- ייצוא אודיו (משמש גם לכתוביות, גם לחיתוך שקט, גם לפודקאסט)
-- ==========================================

-- מייצא מיקס אודיו מלא (או In/Out) של הטיימליין הנוכחית לקובץ WAV
local function exportAudio(outPath, isInOut)
    local timeline = project:GetCurrentTimeline()
    if not timeline then return false, "אין טיים-ליין פעיל" end

    local ok = project:LoadRenderPreset("Audio Only")
    if not ok then
        return false, 'לא נמצא פריסט רינדור בשם "Audio Only". צור אותו פעם אחת בעמוד Deliver ושמור כפריסט.'
    end

    local fileName = outPath:match("([^/\\]+)$")
    local baseName = fileName:gsub("%.wav$", "")
    local targetDir = outPath:sub(1, #outPath - #fileName - 1)

    local renderSettings = {
        SelectAllFrames = not isInOut,
        TargetDir       = targetDir,
        CustomName      = baseName,
        ExportVideo     = false,
        ExportAudio     = true,
        Format          = "wav",
        AudioCodec      = "LinearPCM",
        AudioBitDepth   = 16,
        AudioSampleRate = 16000,
    }

    if isInOut then
        renderSettings.MarkIn  = timeline:GetMarkIn()
        renderSettings.MarkOut = timeline:GetMarkOut()
    end

    project:SetRenderSettings(renderSettings)
    local jobId = project:AddRenderJob()

    if jobId then
        project:StartRendering(jobId)
        local timeout = 300
        while project:IsRenderingInProgress() and timeout > 0 do
            bmd.wait(1)
            timeout = timeout - 1
        end
        if project:IsRenderingInProgress() then
            project:StopRendering()
            return false, "זמן הייצוא עבר את המותר"
        end
    else
        return false, "גרסת Free: לחץ 'Render All' בחלון ה-Deliver והמתן."
    end

    return pathExists(outPath), "קובץ שמע לא נוצר"
end

-- מנטרל את כל טראקי האודיו חוץ מהאחד המבוקש (לצורך בידוד דובר), ומחזיר את המצב המקורי
local function soloAudioTrack(timeline, keepIdx)
    local n = timeline:GetTrackCount("audio")
    local original = {}
    
    for i = 1, n do
        original[i] = {}
        local items = timeline:GetItemListInTrack("audio", i)
        if items then
            for j, item in ipairs(items) do
                -- שמירת המצב המקורי של הקליפ
                original[i][j] = item:GetClipEnabled()
                
                -- השתקת הקליפ אם הוא לא בטראק המבוקש
                if i ~= keepIdx then
                    item:SetClipEnabled(false)
                end
            end
        end
    end
    
    return original
end

local function restoreAudioTracks(timeline, original)
    for i, trackOriginals in pairs(original) do
        local items = timeline:GetItemListInTrack("audio", i)
        if items then
            for j, item in ipairs(items) do
                if trackOriginals[j] ~= nil then
                    item:SetClipEnabled(trackOriginals[j])
                end
            end
        end
    end
end

-- ==========================================
-- FFmpeg - זיהוי שקט
-- ==========================================

-- מריץ FFmpeg silencedetect בצורה שקטה ואסינכרונית, וממתין לסיום דרך קובץ "done"
local function runSilenceDetect(wavPath, thresholdDb, minSilenceSec, uid)
    local logPath  = TEMP_DIR .. SEP .. "autocaps_sil_log_" .. uid .. ".txt"
    local donePath = TEMP_DIR .. SEP .. "autocaps_sil_done_" .. uid .. ".txt"
    local batPath  = TEMP_DIR .. SEP .. "autocaps_sil_run_" .. uid .. ".bat"

    safeRemove(logPath)
    safeRemove(donePath)

    local ffCmd = '"' .. AUTOCAPS_FFMPEG .. '" -i "' .. wavPath .. '" -af "silencedetect=noise=' ..
        tostring(thresholdDb) .. 'dB:d=' .. tostring(minSilenceSec) .. '" -f null - > "' .. logPath .. '" 2>&1'
    local finalCmd = ffCmd .. ' & echo DONE > "' .. donePath .. '"'

    execute_silent_async(finalCmd, batPath)

    local ok = waitForFile(donePath, 180)
    safeRemove(batPath)
    safeRemove(donePath)

    if not ok then
        return nil, nil, "זמן זיהוי השקט עבר את המותר"
    end

    -- ניתוח הלוג
    local silences = {}
    local duration = 0
    local currentStart = nil

    local f = io.open(logPath, "r")
    if f then
        for line in f:lines() do
            local h, m, s = line:match("Duration:%s*(%d+):(%d+):([%d%.]+)")
            if h then
                duration = tonumber(h) * 3600 + tonumber(m) * 60 + tonumber(s)
            end
            local ss = line:match("silence_start:%s+([%-%d%.]+)")
            if ss then currentStart = tonumber(ss) end
            local se = line:match("silence_end:%s+([%-%d%.]+)")
            if se and currentStart ~= nil then
                table.insert(silences, { start = currentStart, ["end"] = tonumber(se) })
                currentStart = nil
            end
        end
        f:close()
    end
    safeRemove(logPath)

    if currentStart ~= nil and duration > currentStart then
        table.insert(silences, { start = currentStart, ["end"] = duration })
    end

    return silences, duration, nil
end

-- הופך רשימת קטעי שקט (עם ריפוד) לרשימת קטעים "לשמירה" (ההפך מהשקט)
local function computeKeepSegments(silences, duration, padSec)
    local keep = {}
    local cursor = 0
    for _, s in ipairs(silences) do
        local adjStart = s.start + padSec
        local adjEnd = s["end"] - padSec
        if adjEnd > adjStart then
            if adjStart > cursor then
                table.insert(keep, { start = cursor, ["end"] = adjStart })
            end
            if adjEnd > cursor then cursor = adjEnd end
        end
    end
    if duration > cursor then
        table.insert(keep, { start = cursor, ["end"] = duration })
    end
    return keep
end

-- ==========================================
-- בניית טיימליין חדשה על בסיס "קטעים לשמירה" (משמש את חיתוך השקט)
-- כל הטראקים (וידאו+אודיו) נחתכים ביחד לפי אותם הקטעים, כך שהסנכרון נשמר.
-- ==========================================

local function buildTrimmedTimeline(keepSegments, namePrefix, onProgress)
    local timeline = project:GetCurrentTimeline()
    if not timeline then return false, "אין טיים-ליין פעיל" end
    local mediaPool = project:GetMediaPool()

    local fps = tonumber(timeline:GetSetting("timelineFrameRate")) or 25
    local timelineStartFrame = timeline:GetStartFrame()

    local videoTrackCount = timeline:GetTrackCount("video")
    local audioTrackCount = timeline:GetTrackCount("audio")

    local newName = namePrefix .. "_" .. os.date("%H%M%S")
    local newTimeline = mediaPool:CreateEmptyTimeline(newName)
    if not newTimeline then return false, "יצירת טיימליין חדשה נכשלה" end

    while newTimeline:GetTrackCount("video") < videoTrackCount do newTimeline:AddTrack("video") end
    while newTimeline:GetTrackCount("audio") < audioTrackCount do newTimeline:AddTrack("audio") end

    local newStartFrame = newTimeline:GetStartFrame()
    local recordCursor = 0
    local totalClips = 0
    local segCount = #keepSegments

    for si, seg in ipairs(keepSegments) do
        local segStartFrame = timelineStartFrame + math.floor(seg.start * fps + 0.5)
        local segEndFrame   = timelineStartFrame + math.floor(seg["end"] * fps + 0.5)
        local segLen = segEndFrame - segStartFrame

        if segLen > 0 then
            local batch = {}
            local trackTypes = { "video", "audio" }
            for _, tType in ipairs(trackTypes) do
                local count = (tType == "video") and videoTrackCount or audioTrackCount
                for idx = 1, count do
                    local items = timeline:GetItemListInTrack(tType, idx)
                    if items then
                        for _, item in ipairs(items) do
                            local clipStart = item:GetStart()
                            local clipEnd = item:GetEnd()
                            local overlapStart = math.max(clipStart, segStartFrame)
                            local overlapEnd = math.min(clipEnd, segEndFrame)
                            if overlapEnd > overlapStart then
                                local ok, mpItem = pcall(function() return item:GetMediaPoolItem() end)
                                if ok and mpItem then
                                    local srcStart = item:GetSourceStartFrame()
                                    local offsetIntoClip = overlapStart - clipStart
                                    local subStart = srcStart + offsetIntoClip
                                    local subEnd = subStart + (overlapEnd - overlapStart)
                                    local recFrame = newStartFrame + recordCursor + (overlapStart - segStartFrame)
                                    table.insert(batch, {
                                        mediaPoolItem = mpItem,
                                        startFrame = subStart,
                                        endFrame = subEnd,
                                        trackIndex = idx,
                                        recordFrame = recFrame,
                                        mediaType = (tType == "video") and 1 or 2,
                                    })
                                    totalClips = totalClips + 1
                                end
                            end
                        end
                    end
                end
            end
            if #batch > 0 then
                mediaPool:AppendToTimeline(batch)
            end
            recordCursor = recordCursor + segLen
        end

        if onProgress then onProgress(si, segCount) end
    end

    return true, newName, totalClips
end

-- ==========================================
-- עריכת פודקאסט - חילוץ תת-קליפ ממקור על בסיס טווח פריימים בטיימליין המקורית,
-- ומיקומו באותו מיקום זמן בדיוק בטיימליין החדשה (ללא ריפוד/כיווץ - רק בחירת מצלמה)
-- ==========================================

local function copyRangeToNewTrack(timeline, tType, srcTrackIdx, frameFrom, frameTo, newTimeline, dstTrackIdx, frameOffset, mediaTypeVal)
    local items = timeline:GetItemListInTrack(tType, srcTrackIdx)
    if not items then return {} end
    local batch = {}
    for _, item in ipairs(items) do
        local clipStart = item:GetStart()
        local clipEnd = item:GetEnd()
        local overlapStart = math.max(clipStart, frameFrom)
        local overlapEnd = math.min(clipEnd, frameTo)
        if overlapEnd > overlapStart then
            local ok, mpItem = pcall(function() return item:GetMediaPoolItem() end)
            if ok and mpItem then
                local srcStart = item:GetSourceStartFrame()
                local offsetIntoClip = overlapStart - clipStart
                local subStart = srcStart + offsetIntoClip
                local subEnd = subStart + (overlapEnd - overlapStart)
                local recFrame = overlapStart + frameOffset
                table.insert(batch, {
                    mediaPoolItem = mpItem,
                    startFrame = subStart,
                    endFrame = subEnd,
                    trackIndex = dstTrackIdx,
                    recordFrame = recFrame,
                    mediaType = mediaTypeVal,
                })
            end
        end
    end
    return batch
end

-- בונה טיימליין חדשה ל"עריכת פודקאסט": וידאו - רק המצלמה הפעילה בכל קטע (על אותו טראק
-- מקורי שלה); אודיו - כל הטראקים המקוריים מועתקים במלואם ובלי חיתוך, כדי לשמור מיקס מלא.
local function buildPodcastTimeline(cutsMap, videoTracksInvolved, namePrefix, onProgress)
    local timeline = project:GetCurrentTimeline()
    if not timeline then return false, "אין טיים-ליין פעיל" end
    local mediaPool = project:GetMediaPool()

    local fps = tonumber(timeline:GetSetting("timelineFrameRate")) or 25
    local timelineStartFrame = timeline:GetStartFrame()
    local videoTrackCount = timeline:GetTrackCount("video")
    local audioTrackCount = timeline:GetTrackCount("audio")

    local newName = namePrefix .. "_" .. os.date("%H%M%S")
    local newTimeline = mediaPool:CreateEmptyTimeline(newName)
    if not newTimeline then return false, "יצירת טיימליין חדשה נכשלה" end

    while newTimeline:GetTrackCount("video") < videoTrackCount do newTimeline:AddTrack("video") end
    while newTimeline:GetTrackCount("audio") < audioTrackCount do newTimeline:AddTrack("audio") end

    local newStartFrame = newTimeline:GetStartFrame()
    local frameOffset = newStartFrame - timelineStartFrame

    -- שלב 1: וידאו - לכל קטע בציר הזמן, מעתיקים רק מהמצלמה הפעילה, לאותו טראק שלה
    local cutCount = #cutsMap
    for ci, cut in ipairs(cutsMap) do
        local chunkStartFrame = timelineStartFrame + math.floor(cut.start * fps + 0.5)
        local chunkEndFrame   = timelineStartFrame + math.floor(cut["end"] * fps + 0.5)
        if chunkEndFrame > chunkStartFrame and cut.activeVidTrack then
            local batch = copyRangeToNewTrack(timeline, "video", cut.activeVidTrack,
                chunkStartFrame, chunkEndFrame, newTimeline, cut.activeVidTrack, frameOffset, 1)
            if #batch > 0 then mediaPool:AppendToTimeline(batch) end
        end
        if onProgress then onProgress(ci, cutCount, "video") end
    end

    -- שלב 2: אודיו - כל טראקי האודיו המקוריים מועתקים במלואם, ללא חיתוך
    for idx = 1, audioTrackCount do
        local batch = copyRangeToNewTrack(timeline, "audio", idx,
            timelineStartFrame, timeline:GetEndFrame() + 1, newTimeline, idx, frameOffset, 2)
        if #batch > 0 then mediaPool:AppendToTimeline(batch) end
        if onProgress then onProgress(idx, audioTrackCount, "audio") end
    end

    return true, newName
end

-- ==========================================
-- לוגיקת בחירת מצלמה לעריכת פודקאסט (זהה באופיה לגרסת פרימייר)
-- speakers = { {videoTrack=n, audioTrack=n, silences={{start,end},...}, duration=n}, ... }
-- ==========================================

local function isSilentAt(t, silences)
    for _, s in ipairs(silences) do
        if t >= s.start and t <= s["end"] then return true end
    end
    return false
end

local function computeCutsMap(speakers, masterVidTrack, minShotDuration)
    local events = { 0 }
    local function pushUnique(v)
        for _, e in ipairs(events) do
            if math.abs(e - v) < 0.0001 then return end
        end
        table.insert(events, v)
    end
    for _, spk in ipairs(speakers) do
        if spk.duration and spk.duration > 0 then pushUnique(spk.duration) end
        for _, s in ipairs(spk.silences) do
            pushUnique(s.start)
            pushUnique(s["end"])
        end
    end
    table.sort(events)

    local cutsMap = {}
    local lastCamera = masterVidTrack or speakers[1].videoTrack

    for i = 1, #events - 1 do
        local chunkStart = events[i]
        local chunkEnd = events[i + 1]
        if (chunkEnd - chunkStart) >= 0.05 then
            local midPoint = (chunkStart + chunkEnd) / 2.0
            local activeSpeakers = {}
            for _, spk in ipairs(speakers) do
                if not isSilentAt(midPoint, spk.silences) then
                    table.insert(activeSpeakers, spk)
                end
            end

            local chosen
            if #activeSpeakers == 1 then
                chosen = activeSpeakers[1].videoTrack
            else
                chosen = masterVidTrack or lastCamera
            end
            lastCamera = chosen

            if #cutsMap > 0 and cutsMap[#cutsMap].activeVidTrack == chosen then
                cutsMap[#cutsMap]["end"] = chunkEnd
            else
                table.insert(cutsMap, { start = chunkStart, ["end"] = chunkEnd, activeVidTrack = chosen })
            end
        end
    end

    -- מעבר החלקה - מיזוג שוטים קצרים מדי
    local needsPass = true
    while needsPass do
        needsPass = false
        for k = 2, #cutsMap - 1 do
            local cut = cutsMap[k]
            local dur = cut["end"] - cut.start
            if dur < minShotDuration then
                local prevCut = cutsMap[k - 1]
                local nextCut = cutsMap[k + 1]
                if prevCut.activeVidTrack == nextCut.activeVidTrack then
                    prevCut["end"] = nextCut["end"]
                    table.remove(cutsMap, k + 1)
                    table.remove(cutsMap, k)
                else
                    prevCut["end"] = cut["end"]
                    table.remove(cutsMap, k)
                    nextCut.start = prevCut["end"]
                end
                needsPass = true
                break
            end
        end
    end

    return cutsMap
end

-- ==========================================
-- ייבוא כתוביות (SRT) לטיימליין - לא השתנה מהגרסה המקורית
-- ==========================================

local function importSrtToTimeline(srtPath)
    local timeline = project:GetCurrentTimeline()
    if not timeline then return false, "אין טיים-ליין פעיל" end

    local mediaPool = project:GetMediaPool()
    local rootBin   = mediaPool:GetRootFolder()

    local autoCapsBin = nil
    for _, sf in ipairs(rootBin:GetSubFolderList() or {}) do
        if sf:GetName() == "AutoCaps" then autoCapsBin = sf; break end
    end
    if not autoCapsBin then
        autoCapsBin = mediaPool:AddSubFolder(rootBin, "AutoCaps")
    end
    mediaPool:SetCurrentFolder(autoCapsBin)

    local okPlace, placeErr = pcall(function()
        local clips = mediaPool:ImportMedia({srtPath})
        if not clips or #clips == 0 then error("הייבוא ל-Media Pool נכשל") end

        local n = timeline:GetTrackCount("subtitle") or 0
        local hasEmpty = false
        for i = 1, n do
            local items = timeline:GetItemListInTrack("subtitle", i)
            if not items or #items == 0 then
                hasEmpty = true
                break
            end
        end

        if not hasEmpty then
            timeline:AddTrack("subtitle")
        end

        local placed = mediaPool:AppendToTimeline({ clips[1] })
        if not placed or #placed == 0 then error("ההוספה לטיימליין נכשלה (AppendToTimeline)") end
    end)

    if not okPlace then
        return false, tostring(placeErr)
    end

    return true, "הכתוביות נוספו לסיקוונס"
end

-- ==========================================
-- עיצוב - QSS (Qt Style Sheet) בהשראת פאנל הפרימייר
-- ==========================================

local QSS = [[
QWidget { background-color: #181818; color: #E2E2E2; font-family: "Segoe UI"; font-size: 12px; }
QLabel#sectionTitle { color: #959595; font-weight: bold; font-size: 11px; }
QLabel#headerTitle { color: #FFFFFF; font-size: 18px; font-weight: bold; }
QLabel#headerSubtitle { color: #959595; font-size: 11px; }
QGroupBox { background-color: #232323; border: 1px solid #323232; border-radius: 6px; margin-top: 6px; padding: 8px; }
QComboBox, QSpinBox, QDoubleSpinBox, QLineEdit {
    background-color: #1D1D1D; color: #E2E2E2; border: 1px solid #323232;
    border-radius: 4px; padding: 4px 6px;
}
QComboBox:hover, QSpinBox:hover, QDoubleSpinBox:hover, QLineEdit:hover { border-color: #4A4A4A; }
QPushButton {
    background-color: #1473E6; color: #FFFFFF; border: none; border-radius: 4px;
    padding: 8px 14px; font-weight: 600;
}
QPushButton:hover { background-color: #0d5cb8; }
QPushButton:disabled { background-color: #3A3A3A; color: #959595; }
QCheckBox { color: #E2E2E2; }
QLabel#statusLbl { color: #959595; }
QSlider::groove:horizontal { background: #1D1D1D; border: 1px solid #323232; height: 6px; border-radius: 3px; }
QSlider::sub-page:horizontal { background: #1473E6; border-radius: 3px; }
QSlider::handle:horizontal { width: 0px; }
]]

-- ==========================================
-- עיצוב ממשק המשתמש
-- ==========================================

local width, height = 620, 900
local win = disp:AddWindow({
    ID = "AutoCapsWin",
    WindowTitle = "AutoCaps",
    Geometry = {200, 120, width, height},
    StyleSheet = QSS,

    ui:VGroup {
        ID = "RootGroup",
        Spacing = 10,
        Margin = 18,

        ui:VGroup {
            Weight = 0,
            ui:Label { ID = "TitleLbl", Text = "AutoCaps", Alignment = { AlignHCenter = true }, Weight = 0 },
            ui:Label { ID = "SubtitleLbl", Text = "תמלול, כתוביות, חיתוך שקט ועריכת פודקאסט אוטומטית", Alignment = { AlignHCenter = true }, Weight = 0 },
        },

        ui:VGap(6),

        -- שורת מעברי-מקטע (במקום Accordion שאינו קיים ב-UIManager)
        ui:HGroup {
            Weight = 0, Spacing = 6,
            ui:Button { ID = "NavCaptions", Text = "כתוביות", Weight = 1 },
            ui:Button { ID = "NavSilence",  Text = "חיתוך שקט", Weight = 1 },
            ui:Button { ID = "NavPodcast",  Text = "פודקאסט", Weight = 1 },
        },

        ui:VGap(4),

        -- ============== מקטע 1: כתוביות ==============
        ui:VGroup {
            ID = "PanelCaptions",
            Weight = 1, Spacing = 10,

            ui:Label { Text = "הגדרות פרויקט", ID = "sectionTitle1", Weight = 0 },
            ui:HGroup {
                Weight = 0,
                ui:ComboBox { ID = "ComboLang", Weight = 0.6 },
                ui:Label { Text = ":שפת התמלול", Weight = 0.4, Alignment = { AlignRight = true } },
            },
            ui:HGroup {
                Weight = 0,
                ui:ComboBox { ID = "ComboRange", Weight = 0.6 },
                ui:Label { Text = ":טווח טיים-ליין", Weight = 0.4, Alignment = { AlignRight = true } },
            },

            ui:Label { Text = "הגדרות עיצוב טקסט", Weight = 0 },
            ui:HGroup {
                Weight = 0,
                ui:SpinBox { ID = "SpinWords", Value = 8, Minimum = 1, Maximum = 15, Weight = 0.6 },
                ui:Label { Text = ":(מילים בשורה (מקס", Weight = 0.4, Alignment = { AlignRight = true } },
            },
            ui:HGroup {
                Weight = 0,
                ui:SpinBox { ID = "SpinLines", Value = 1, Minimum = 1, Maximum = 4, Weight = 0.6 },
                ui:Label { Text = ":(שורות בכתובית (מקס", Weight = 0.4, Alignment = { AlignRight = true } },
            },
            ui:HGroup {
                Weight = 0,
                ui:CheckBox { ID = "CheckPunctuation", Text = "", Checked = false, Weight = 0.1 },
                ui:Label { Text = "הסרת סימני פיסוק מהכתוביות", Weight = 0.9, Alignment = { AlignRight = true } },
            },

            ui:Label { Text = "מנוע עיבוד", Weight = 0 },
            ui:HGroup {
                Weight = 0,
                ui:ComboBox { ID = "ComboDevice", Weight = 0.6 },
                ui:Label { Text = ":מנוע חומרה", Weight = 0.4, Alignment = { AlignRight = true } },
            },

            ui:VGap(6),
            ui:Label { ID = "StatusLbl", ObjectName = "statusLbl", Text = "מוכן לעבודה...", Alignment = { AlignHCenter = true }, Weight = 0 },
            ui:Button { ID = "BtnRun", Text = "הפעל תמלול וכתוביות", MinimumSize = {0, 34}, Weight = 0 },
        },

        -- ============== מקטע 2: חיתוך שקט ==============
        ui:VGroup {
            ID = "PanelSilence",
            Weight = 1, Spacing = 10, Hidden = true,

            ui:Label { Text = "הגדרות חיתוך שקט", Weight = 0 },
            ui:HGroup {
                Weight = 0,
                ui:SpinBox { ID = "SilThreshold", Value = -35, Minimum = -80, Maximum = -10, Weight = 0.6 },
                ui:Label { Text = ":עוצמת רעש (dB)", Weight = 0.4, Alignment = { AlignRight = true } },
            },
            ui:HGroup {
                Weight = 0,
                ui:SpinBox { ID = "SilDuration", Value = 150, Minimum = 50, Maximum = 5000, Weight = 0.6 },
                ui:Label { Text = ":אורך שקט מינימלי (ms)", Weight = 0.4, Alignment = { AlignRight = true } },
            },
            ui:HGroup {
                Weight = 0,
                ui:SpinBox { ID = "SilPad", Value = 150, Minimum = 0, Maximum = 2000, Weight = 0.6 },
                ui:Label { Text = ":ריפוד שוליים (ms)", Weight = 0.4, Alignment = { AlignRight = true } },
            },

            ui:Label {
                Text = "פעולה זו יוצרת טיימליין חדשה עם השקטים מוסרים (הטיימליין הנוכחית נשארת ללא שינוי).",
                WordWrap = true, Alignment = { AlignRight = true }, Weight = 0,
            },

            ui:VGap(6),
            ui:Label { ID = "StatusSilence", ObjectName = "statusLbl", Text = "מוכן לחיתוך...", Alignment = { AlignHCenter = true }, Weight = 0 },
            ui:Button { ID = "BtnCutSilence", Text = "חתוך שקט (יוצר טיימליין חדשה)", MinimumSize = {0, 34}, Weight = 0 },
        },

        -- ============== מקטע 3: עריכת פודקאסט ==============
        ui:VGroup {
            ID = "PanelPodcast",
            Weight = 1, Spacing = 10, Hidden = true,

            ui:Label { Text = "משתתפים", Weight = 0 },
            ui:HGroup {
                Weight = 0,
                ui:ComboBox { ID = "PodSpeakerCount", Weight = 0.6 },
                ui:Label { Text = ":כמות משתתפים", Weight = 0.4, Alignment = { AlignRight = true } },
            },

            -- שורות דובר קבועות (1-4), מוסתרות/מוצגות דינמית לפי הכמות שנבחרה
            ui:HGroup { Weight = 0, ID = "PodRow1",
                ui:SpinBox { ID = "PodSpk1Vid", Value = 1, Minimum = 1, Maximum = 20, Weight = 1 },
                ui:Label { Text = "וידאו-1", Weight = 0.6, Alignment = { AlignRight = true } },
                ui:SpinBox { ID = "PodSpk1Aud", Value = 1, Minimum = 1, Maximum = 20, Weight = 1 },
                ui:Label { Text = "אודיו-1", Weight = 0.6, Alignment = { AlignRight = true } },
            },
            ui:HGroup { Weight = 0, ID = "PodRow2",
                ui:SpinBox { ID = "PodSpk2Vid", Value = 2, Minimum = 1, Maximum = 20, Weight = 1 },
                ui:Label { Text = "וידאו-2", Weight = 0.6, Alignment = { AlignRight = true } },
                ui:SpinBox { ID = "PodSpk2Aud", Value = 2, Minimum = 1, Maximum = 20, Weight = 1 },
                ui:Label { Text = "אודיו-2", Weight = 0.6, Alignment = { AlignRight = true } },
            },
            ui:HGroup { Weight = 0, ID = "PodRow3", Hidden = true,
                ui:SpinBox { ID = "PodSpk3Vid", Value = 3, Minimum = 1, Maximum = 20, Weight = 1 },
                ui:Label { Text = "וידאו-3", Weight = 0.6, Alignment = { AlignRight = true } },
                ui:SpinBox { ID = "PodSpk3Aud", Value = 3, Minimum = 1, Maximum = 20, Weight = 1 },
                ui:Label { Text = "אודיו-3", Weight = 0.6, Alignment = { AlignRight = true } },
            },
            ui:HGroup { Weight = 0, ID = "PodRow4", Hidden = true,
                ui:SpinBox { ID = "PodSpk4Vid", Value = 4, Minimum = 1, Maximum = 20, Weight = 1 },
                ui:Label { Text = "וידאו-4", Weight = 0.6, Alignment = { AlignRight = true } },
                ui:SpinBox { ID = "PodSpk4Aud", Value = 4, Minimum = 1, Maximum = 20, Weight = 1 },
                ui:Label { Text = "אודיו-4", Weight = 0.6, Alignment = { AlignRight = true } },
            },

            ui:Label { Text = 'זווית "כולם ביחד" (אופציונלי)', Weight = 0 },
            ui:HGroup {
                Weight = 0,
                ui:CheckBox { ID = "PodUseMaster", Text = "", Checked = false, Weight = 0.1 },
                ui:Label { Text = "יש מצלמה נוספת עם כולם ביחד", Weight = 0.9, Alignment = { AlignRight = true } },
            },
            ui:HGroup { Weight = 0, ID = "PodMasterRow", Hidden = true,
                ui:SpinBox { ID = "PodMasterVid", Value = 1, Minimum = 1, Maximum = 20, Weight = 0.6 },
                ui:Label { Text = ":מספר טראק וידאו (כולם ביחד)", Weight = 0.4, Alignment = { AlignRight = true } },
            },

            ui:Label { Text = "הגדרות זיהוי דיבור וקאטים", Weight = 0 },
            ui:HGroup {
                Weight = 0,
                ui:SpinBox { ID = "PodThreshold", Value = -30, Minimum = -80, Maximum = -10, Weight = 0.6 },
                ui:Label { Text = ":עוצמת רעש (dB)", Weight = 0.4, Alignment = { AlignRight = true } },
            },
            ui:HGroup {
                Weight = 0,
                ui:SpinBox { ID = "PodMinSilence", Value = 500, Minimum = 100, Maximum = 5000, Weight = 0.6 },
                ui:Label { Text = ":אורך שקט מינימלי (ms)", Weight = 0.4, Alignment = { AlignRight = true } },
            },
            ui:HGroup {
                Weight = 0,
                ui:DoubleSpinBox { ID = "PodMinShot", Value = 1.2, Minimum = 0.2, Maximum = 10.0, SingleStep = 0.1, Weight = 0.6 },
                ui:Label { Text = ":אורך שוט מינימלי (שניות)", Weight = 0.4, Alignment = { AlignRight = true } },
            },

            ui:Label {
                Text = "פעולה זו יוצרת טיימליין חדשה עם מעבר מצלמות אוטומטי (הטיימליין הנוכחית נשארת ללא שינוי).",
                WordWrap = true, Alignment = { AlignRight = true }, Weight = 0,
            },

            ui:VGap(6),
            ui:Label { ID = "StatusPodcast", ObjectName = "statusLbl", Text = "מוכן לעריכה...", Alignment = { AlignHCenter = true }, Weight = 0 },
            ui:Slider { ID = "PodcastProgress", Minimum = 0, Maximum = 100, Value = 0, Enabled = false, Weight = 0 },
            ui:Button { ID = "BtnPodcastDirector", Text = "ערוך פודקאסט אוטומטית (יוצר טיימליין חדשה)", MinimumSize = {0, 34}, Weight = 0 },
        },
    }
})

local itm = win:GetItems()

itm.ComboLang:AddItem("he")
itm.ComboLang:AddItem("en")

itm.ComboRange:AddItem("entire")
itm.ComboRange:AddItem("inOut")

itm.ComboDevice:AddItem("cuda")
itm.ComboDevice:AddItem("cpu")

itm.PodSpeakerCount:AddItem("2")
itm.PodSpeakerCount:AddItem("3")
itm.PodSpeakerCount:AddItem("4")

-- ==========================================
-- ניווט בין המקטעים (כתוביות / שקט / פודקאסט)
-- ==========================================

local function showPanel(name)
    itm.PanelCaptions.Hidden = (name ~= "captions")
    itm.PanelSilence.Hidden  = (name ~= "silence")
    itm.PanelPodcast.Hidden  = (name ~= "podcast")
end

win.On.NavCaptions.Clicked = function(ev) showPanel("captions") end
win.On.NavSilence.Clicked  = function(ev) showPanel("silence") end
win.On.NavPodcast.Clicked  = function(ev) showPanel("podcast") end

win.On.PodSpeakerCount.CurrentIndexChanged = function(ev)
    local count = tonumber(itm.PodSpeakerCount.CurrentText) or 2
    itm.PodRow3.Hidden = (count < 3)
    itm.PodRow4.Hidden = (count < 4)
end

win.On.PodUseMaster.Clicked = function(ev)
    itm.PodMasterRow.Hidden = not itm.PodUseMaster.Checked
end

win.On.AutoCapsWin.Close = function(ev)
    disp:ExitLoop()
end

-- ==========================================
-- מקטע 1: כתוביות ותמלול (זהה מהותית לגרסה המקורית)
-- ==========================================

win.On.BtnRun.Clicked = function(ev)
    if not project or not project:GetCurrentTimeline() then
        itm.StatusLbl.Text = "שגיאה: פתח פרויקט וטיים-ליין תחילה."
        return
    end

    itm.BtnRun.Enabled = false
    itm.StatusLbl.Text = "מייצא אודיו מהטיימליין..."

    if not pathExists(AUTOCAPS_EXE) then
        itm.StatusLbl.Text = "שגיאה: מנוע לא הותקן!"
        itm.BtnRun.Enabled = true
        return
    end

    local timestamp = os.date("%Y%m%d_%H%M%S")
    local audioOut = TEMP_DIR .. SEP .. "autocaps_audio_" .. timestamp .. ".wav"
    local srtOut   = TEMP_DIR .. SEP .. "autocaps_subs_" .. timestamp .. ".srt"
    local doneFile = TEMP_DIR .. SEP .. "autocaps_done_" .. timestamp .. ".txt"
    local logPath  = TEMP_DIR .. SEP .. "autocaps_log_" .. timestamp .. ".txt"
    local batPath  = TEMP_DIR .. SEP .. "autocaps_run_" .. timestamp .. ".bat"

    local isInOut = (itm.ComboRange.CurrentText == "inOut")

    local exportOk, exportMsg = exportAudio(audioOut, isInOut)
    if not exportOk then
        itm.StatusLbl.Text = "שגיאה בייצוא: " .. (exportMsg or "")
        itm.BtnRun.Enabled = true
        return
    end

    itm.StatusLbl.Text = "מתחיל תמלול..."

    local lang     = itm.ComboLang.CurrentText
    local device   = itm.ComboDevice.CurrentText
    local maxWords = itm.SpinWords.Value
    local maxLines = itm.SpinLines.Value
    local rmPunc   = itm.CheckPunctuation.Checked
    local model    = "ivrit-ai/whisper-large-v3-turbo-ct2"

    local cmdArgs = string.format('"%s" "%s" "%s" --language %s --model "%s" --model-dir "%s" --device %s --max-words-per-line %d --max-lines-per-subtitle %d',
        AUTOCAPS_EXE, audioOut, srtOut, lang, model, AUTOCAPS_MODELS, device, maxWords, maxLines)

    if rmPunc then
        cmdArgs = cmdArgs .. " --remove-punctuation"
    end

    local finalCmd = 'set "PATH=' .. AUTOCAPS_CUDA .. ';%PATH%" && set "CUDA_DIR=' .. AUTOCAPS_CUDA .. '" && set "PYTHONUNBUFFERED=1" && ' .. cmdArgs .. ' > "' .. logPath .. '" 2>&1 & echo DONE > "' .. doneFile .. '"'

    execute_silent_async(finalCmd, batPath)

    local timeout = 600
    while not pathExists(doneFile) and timeout > 0 do
        bmd.wait(1)
        timeout = timeout - 1
        if pathExists(logPath) then
            local progress, eta = read_log_progress(logPath)
            if progress then
                local statusText = string.format("מתמלל: %.1f%%", progress)
                if eta and eta > 0 then
                    statusText = statusText .. string.format(" (נשאר כ-%.0f שניות)", eta)
                end
                itm.StatusLbl.Text = statusText
            end
        end
    end

    if timeout <= 0 then
        itm.StatusLbl.Text = "שגיאה: התמלול לקח יותר מדי זמן."
        itm.BtnRun.Enabled = true
        return
    end

    if pathExists(srtOut) then
        itm.StatusLbl.Text = "מייבא כתוביות לטיים-ליין..."
        local imported, importMsg = importSrtToTimeline(srtOut)

        if imported then
            itm.StatusLbl.Text = "הושלם! " .. importMsg
        else
            itm.StatusLbl.Text = "ייבוא אוטומטי נכשל. גרור את ה-SRT ידנית מתיקיית AutoCaps."
            print("Import Error: " .. (importMsg or ""))
        end
    else
        local errorMsg = "שגיאה לא ידועה במנוע"
        local lf = io.open(logPath, "r")
        if lf then
            for line in lf:lines() do
                if line:match("[Ee]rror") or line:match("Traceback") or #line > 0 then
                    errorMsg = line
                end
            end
            lf:close()
        end
        itm.StatusLbl.Text = "שגיאה: " .. errorMsg
    end

    safeRemove(audioOut)
    safeRemove(doneFile)
    safeRemove(batPath)

    itm.BtnRun.Enabled = true
end

-- ==========================================
-- מקטע 2: חיתוך שקט
-- ==========================================

win.On.BtnCutSilence.Clicked = function(ev)
    local timeline = project and project:GetCurrentTimeline()
    if not timeline then
        itm.StatusSilence.Text = "שגיאה: פתח פרויקט וטיים-ליין תחילה."
        return
    end
    if not pathExists(AUTOCAPS_FFMPEG) then
        itm.StatusSilence.Text = "שגיאה: FFmpeg לא נמצא בנתיב: " .. AUTOCAPS_FFMPEG
        return
    end

    itm.BtnCutSilence.Enabled = false
    itm.StatusSilence.Text = "מייצא אודיו מהטיימליין..."

    local uid = os.date("%Y%m%d_%H%M%S")
    local wavPath = TEMP_DIR .. SEP .. "autocaps_silscan_" .. uid .. ".wav"

    local exportOk, exportMsg = exportAudio(wavPath, false)
    if not exportOk then
        itm.StatusSilence.Text = "שגיאה בייצוא האודיו: " .. (exportMsg or "")
        itm.BtnCutSilence.Enabled = true
        return
    end

    itm.StatusSilence.Text = "מנתח גלי קול (מאתר שקט)..."

    local thresholdDb = itm.SilThreshold.Value
    local durationSec = itm.SilDuration.Value / 1000.0
    local padSec = itm.SilPad.Value / 1000.0

    local silences, duration, errMsg = runSilenceDetect(wavPath, thresholdDb, durationSec, uid)
    safeRemove(wavPath)

    if not silences then
        itm.StatusSilence.Text = "שגיאה בזיהוי שקט: " .. (errMsg or "")
        itm.BtnCutSilence.Enabled = true
        return
    end

    local keepSegments = computeKeepSegments(silences, duration, padSec)

    if #keepSegments == 0 then
        itm.StatusSilence.Text = "לא נמצאו קטעים לשמירה (כל הטיימליין זוהה כשקט?)."
        itm.BtnCutSilence.Enabled = true
        return
    end

    itm.StatusSilence.Text = "בונה טיימליין חדשה ללא שקטים..."

    local ok, nameOrErr, clipCount = buildTrimmedTimeline(keepSegments, "AutoCaps_NoSilence", function(i, total)
        itm.StatusSilence.Text = string.format("בונה טיימליין: קטע %d מתוך %d...", i, total)
    end)

    if ok then
        itm.StatusSilence.Text = string.format('הושלם! נוצרה טיימליין חדשה: "%s" (%d קליפים, %d קטעים נשמרו).', nameOrErr, clipCount or 0, #keepSegments)
    else
        itm.StatusSilence.Text = "שגיאה: " .. tostring(nameOrErr)
    end

    itm.BtnCutSilence.Enabled = true
end

-- ==========================================
-- מקטע 3: עריכת פודקאסט אוטומטית
-- ==========================================

win.On.BtnPodcastDirector.Clicked = function(ev)
    local timeline = project and project:GetCurrentTimeline()
    if not timeline then
        itm.StatusPodcast.Text = "שגיאה: פתח פרויקט וטיים-ליין תחילה."
        return
    end
    if not pathExists(AUTOCAPS_FFMPEG) then
        itm.StatusPodcast.Text = "שגיאה: FFmpeg לא נמצא בנתיב: " .. AUTOCAPS_FFMPEG
        return
    end

    itm.BtnPodcastDirector.Enabled = false
    itm.PodcastProgress.Value = 0

    local ok, err = pcall(function()
        local speakerCount = tonumber(itm.PodSpeakerCount.CurrentText) or 2
        local useMaster = itm.PodUseMaster.Checked
        local masterVidTrack = useMaster and itm.PodMasterVid.Value or nil

        local threshold = itm.PodThreshold.Value
        local minSilenceSec = itm.PodMinSilence.Value / 1000.0
        local minShotDuration = itm.PodMinShot.Value

        local speakers = {}
        local vidFields = { itm.PodSpk1Vid, itm.PodSpk2Vid, itm.PodSpk3Vid, itm.PodSpk4Vid }
        local audFields = { itm.PodSpk1Aud, itm.PodSpk2Aud, itm.PodSpk3Aud, itm.PodSpk4Aud }
        for i = 1, speakerCount do
            table.insert(speakers, { videoTrack = vidFields[i].Value, audioTrack = audFields[i].Value })
        end

        local uid = os.date("%Y%m%d_%H%M%S")

        -- שלב 1: ייצוא וניתוח אודיו לכל דובר בנפרד (סולו טראק בכל פעם)
        for i, spk in ipairs(speakers) do
            itm.StatusPodcast.Text = string.format("מייצא אודיו - דובר %d...", i)
            itm.PodcastProgress.Value = math.floor((i - 1) / #speakers * 40)

            local wavPath = TEMP_DIR .. SEP .. "autocaps_pod_spk" .. i .. "_" .. uid .. ".wav"
            local originalStates = soloAudioTrack(timeline, spk.audioTrack)
            local exportOk, exportMsg = exportAudio(wavPath, false)
            restoreAudioTracks(timeline, originalStates)

            if not exportOk then
                error("ייצוא אודיו לדובר " .. i .. " נכשל: " .. tostring(exportMsg))
            end

            itm.StatusPodcast.Text = string.format("מנתח שקט - דובר %d...", i)
            local silences, duration, errMsg = runSilenceDetect(wavPath, threshold, minSilenceSec, "pod" .. i .. "_" .. uid)
            safeRemove(wavPath)

            if not silences then
                error("ניתוח שקט לדובר " .. i .. " נכשל: " .. tostring(errMsg))
            end

            spk.silences = silences
            spk.duration = duration
        end

        -- שלב 2+3: מפת חיתוכים (בחירת מצלמה פעילה) + החלקה
        itm.StatusPodcast.Text = "מחשב מפת חיתוכים..."
        itm.PodcastProgress.Value = 55
        local cutsMap = computeCutsMap(speakers, masterVidTrack, minShotDuration)

        if #cutsMap == 0 then
            error("לא נמצאו קטעי דיבור תקינים")
        end

        -- שלב 4: בניית טיימליין חדשה עם מעבר המצלמות
        itm.StatusPodcast.Text = "בונה טיימליין חדשה עם מעבר מצלמות..."
        local builtOk, nameOrErr = buildPodcastTimeline(cutsMap, nil, "AutoCaps_Podcast", function(i, total, phase)
            local pct = 60 + math.floor((i / math.max(total,1)) * 35)
            itm.PodcastProgress.Value = math.min(pct, 95)
            itm.StatusPodcast.Text = string.format("מיישם חיתוכים (%s): %d/%d...", phase, i, total)
        end)

        if not builtOk then
            error(tostring(nameOrErr))
        end

        itm.PodcastProgress.Value = 100
        itm.StatusPodcast.Text = string.format('הושלם! נוצרה טיימליין חדשה: "%s" (%d חיתוכים).', nameOrErr, #cutsMap)
    end)

    if not ok then
        itm.StatusPodcast.Text = "שגיאה: " .. tostring(err)
        itm.PodcastProgress.Value = 0
    end

    itm.BtnPodcastDirector.Enabled = true
end

-- ==========================================
-- הצגת החלון
-- ==========================================

showPanel("captions")
win:Show()
disp:RunLoop()
win:Hide()
