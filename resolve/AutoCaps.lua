-- ==========================================================
-- AutoCaps - DaVinci Resolve Edition
-- כתוביות אוטומטיות, ממשק דמוי Premiere, והרצה שקטה לחלוטין
-- ==========================================================

local ffi = require("ffi")
local ui  = fu.UIManager
local disp = bmd.UIDispatcher(ui)

local resolve = Resolve()
local projectManager = resolve:GetProjectManager()
local project = projectManager:GetCurrentProject()

local IS_WINDOWS = (package.config:sub(1,1) == "\\")

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
-- פונקציות עזר ומערכת
-- ==========================================

local function pathExists(p)
    local f = io.open(p, "r")
    if f then f:close(); return true end
    return false
end

local function execute_silent_async(cmd, bat_path)
    if IS_WINDOWS and shell32 then
        -- יצירת קובץ BAT שיריץ את הפקודה וייצור קובץ סיום
        local f = io.open(bat_path, "w")
        if f then
            f:write("@echo off\n" .. cmd .. "\n")
            f:close()
            -- הרצה שקטה לחלוטין (0 = SW_HIDE)
            shell32.ShellExecuteA(nil, "open", bat_path, nil, nil, 0)
        else
            os.execute('start /b "" cmd /c "' .. cmd .. '"')
        end
    else
        os.execute(cmd .. " &")
    end
end

-- פונקציה לקריאת אחוזים וזמן שנותר מקובץ הלוג בזמן אמת
local function read_log_progress(logPath)
    local f = io.open(logPath, "r")
    if not f then return nil, nil end

    local progress = nil
    local eta = nil

    -- קריאת כל השורות וחיפוש הערך האחרון ביותר שנכתב
    for line in f:lines() do
        local progress_pct = line:match('"progress_pct"%s*:%s*([%d%.]+)')
        local eta_sec = line:match('"eta_sec"%s*:%s*([%d%.]+)')

        if progress_pct then
            progress = tonumber(progress_pct)
        end
        if eta_sec then
            eta = tonumber(eta_sec)
        end
    end

    f:close()
    return progress, eta
end

-- ==========================================
-- ייצוא אודיו וייבוא כתוביות (השראה חכמה)
-- ==========================================

local function exportAudio(outPath, isInOut)
    local timeline = project:GetCurrentTimeline()
    if not timeline then return false, "אין טיים-ליין פעיל" end

    project:LoadRenderPreset("Audio Only")
    local tempDir = os.getenv("TEMP") or "C:\\Windows\\Temp"
    
    -- חילוץ שם הקובץ מהנתיב
    local fileName = outPath:match("([^/\\]+)$")
    local baseName = fileName:gsub("%.wav$", "")

    local renderSettings = {
        SelectAllFrames = not isInOut,
        TargetDir       = tempDir,
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
        -- רינדור אוטומטי
        project:StartRendering(jobId)
        local timeout = 300
        while project:IsRenderingInProgress() and timeout > 0 do
            bmd.wait(1) -- המתנה שאינה תוקעת את הממשק
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

local function importSrtToTimeline(srtPath)
    local timeline = project:GetCurrentTimeline()
    if not timeline then return false, "אין טיים-ליין פעיל" end

    local mediaPool = project:GetMediaPool()
    local rootBin   = mediaPool:GetRootFolder()

    -- חיפוש או יצירת תיקיית AutoCaps ב-Media Pool כדי לשמור על סדר
    local autoCapsBin = nil
    for _, sf in ipairs(rootBin:GetSubFolderList() or {}) do
        if sf:GetName() == "AutoCaps" then autoCapsBin = sf; break end
    end
    if not autoCapsBin then
        autoCapsBin = mediaPool:AddSubFolder(rootBin, "AutoCaps")
    end
    mediaPool:SetCurrentFolder(autoCapsBin)

    -- שימוש ב-pcall לטיפול בטוח בשגיאות במהלך הייבוא וההשמה
    local okPlace, placeErr = pcall(function()
        local clips = mediaPool:ImportMedia({srtPath})
        if not clips or #clips == 0 then error("הייבוא ל-Media Pool נכשל") end

        -- בדיקה אם יש ערוץ כתוביות ריק
        local n = timeline:GetTrackCount("subtitle") or 0
        local hasEmpty = false
        for i = 1, n do
            local items = timeline:GetItemListInTrack("subtitle", i)
            if not items or #items == 0 then 
                hasEmpty = true 
                break 
            end
        end
        
        -- אם אין ערוץ ריק, נוסיף אחד חדש
        if not hasEmpty then 
            timeline:AddTrack("subtitle") 
        end

        -- הוספה ישירה לטיימליין
        local placed = mediaPool:AppendToTimeline({ clips[1] })
        if not placed or #placed == 0 then error("ההוספה לטיימליין נכשלה (AppendToTimeline)") end
    end)
    
    if not okPlace then
        -- במקרה של שגיאה נחזיר false ואת הודעת השגיאה
        return false, tostring(placeErr)
    end

    return true, "הכתוביות נוספו לסיקוונס"
end

-- ==========================================
-- עיצוב ממשק המשתמש (מותאם לעברית - בלי דחיפה החוצה)
-- ==========================================

local width, height = 600, 770
local win = disp:AddWindow({
    ID = "AutoCapsWin",
    WindowTitle = "AutoCaps - Subtitles",
    Geometry = {200, 200, width, height},
    
    ui:VGroup {
        ID = "RootGroup",
        Spacing = 10,
        Margin = 20,

        -- כותרת ראשית 
        ui:VGroup {
            Weight = 0,
            ui:Label { 
                Text = "AutoCaps", 
                Font = ui:Font { PixelSize = 24, Bold = true },
                Alignment = { AlignHCenter = true },
                Weight = 0
            },
            ui:Label { 
                Text = "מערכת תמלול וכתוביות מתקדמת", 
                Font = ui:Font { PixelSize = 12, Italic = true },
                Alignment = { AlignHCenter = true },
                Weight = 0
            }
        },

        ui:VGap(5),
        ui:Label{ Weight = 0, FrameStyle = 4 }, 
        ui:VGap(5),

        -- בלוק 1: הגדרות פרויקט
        ui:Label { Text = "הגדרות פרויקט", Font = ui:Font { PixelSize = 14, Bold = true }, Weight = 0, Alignment = { AlignRight = true } },
        ui:VGroup {
            Weight = 0, Spacing = 8, Margin = 0,
            ui:HGroup {
                Weight = 0,
                ui:ComboBox { ID = "ComboLang", Weight = 0.7 },
                ui:Label { Text = ":שפת התמלול", Weight = 0.3, Alignment = { AlignRight = true } }
            },
            ui:HGroup {
                Weight = 0,
                ui:ComboBox { ID = "ComboRange", Weight = 0.7 },
                ui:Label { Text = ":טווח טיים-ליין", Weight = 0.3, Alignment = { AlignRight = true } }
            }
        },

        ui:VGap(5),
        ui:Label{ Weight = 0, FrameStyle = 4 }, 
        ui:VGap(5),

        -- בלוק 2: הגדרות כתוביות
        ui:Label { Text = "הגדרות עיצוב טקסט", Font = ui:Font { PixelSize = 14, Bold = true }, Weight = 0, Alignment = { AlignRight = true } },
        ui:VGroup {
            Weight = 0, Spacing = 8, Margin = 0,
            ui:HGroup {
                Weight = 0,
                ui:SpinBox { ID = "SpinWords", Value = 8, Minimum = 1, Maximum = 15, Weight = 0.7 },
                ui:Label { Text = ":(מילים בשורה (מקס", Weight = 0.3, Alignment = { AlignRight = true } }
            },
            ui:HGroup {
                Weight = 0,
                ui:SpinBox { ID = "SpinLines", Value = 2, Minimum = 1, Maximum = 4, Weight = 0.7 },
                ui:Label { Text = ":(שורות בכתובית (מקס", Weight = 0.3, Alignment = { AlignRight = true } }
            },
            ui:HGroup {
                Weight = 0,
                ui:CheckBox { ID = "CheckPunctuation", Text = "", Checked = false, Weight = 0.1 },
                ui:Label { Text = "הסרת סימני פיסוק מהכתוביות", Weight = 0.9, Alignment = { AlignRight = true } }
            }
        },

        ui:VGap(5),
        ui:Label{ Weight = 0, FrameStyle = 4 }, 
        ui:VGap(5),

        -- בלוק 3: חומרה ועיבוד
        ui:Label { Text = "מנוע עיבוד", Font = ui:Font { PixelSize = 14, Bold = true }, Weight = 0, Alignment = { AlignRight = true } },
        ui:VGroup {
            Weight = 0, Spacing = 8, Margin = 0,
            ui:HGroup {
                Weight = 0,
                ui:ComboBox { ID = "ComboDevice", Weight = 0.7 },
                ui:Label { Text = ":מנוע חומרה", Weight = 0.3, Alignment = { AlignRight = true } }
            }
        },

        -- החלפנו את החלל הגמיש הבעייתי במרווח קבוע של 15 פיקסלים
        ui:VGap(15),

        ui:Label{ Weight = 0, FrameStyle = 4 }, 
        ui:VGap(5),

        -- בלוק 4: אזור הפעולה
        ui:VGroup {
            Weight = 0,
            Spacing = 10,
            ui:Label { 
                ID = "StatusLbl", 
                Text = "מוכן לעבודה...", 
                Alignment = { AlignHCenter = true },
                Font = ui:Font { PixelSize = 13 },
                Weight = 0
            },
            ui:Button { 
                ID = "BtnRun", 
                Text = "הפעל AutoCaps", 
                MinimumSize = {0, 35}, 
                Font = ui:Font { PixelSize = 14, Bold = true },
                Weight = 0
            }
        }
    }
})

local itm = win:GetItems()

itm.ComboLang:AddItem("he")
itm.ComboLang:AddItem("en")

itm.ComboRange:AddItem("entire")
itm.ComboRange:AddItem("inOut")

itm.ComboDevice:AddItem("cuda")
itm.ComboDevice:AddItem("cpu")

-- ==========================================
-- לוגיקת הכפתור הראשי
-- ==========================================

win.On.AutoCapsWin.Close = function(ev)
    disp:ExitLoop()
end

win.On.BtnRun.Clicked = function(ev)
    if not project or not project:GetCurrentTimeline() then
        itm.StatusLbl.Text = "שגיאה: פתח פרויקט וטיים-ליין תחילה."
        return
    end

    itm.BtnRun.Enabled = false
    itm.StatusLbl.Text = "מייצא אודיו מהטיימליין..."

    -- הגדרת נתיבים לפי מבנה התיקיות
    local localAppData = os.getenv("LOCALAPPDATA")
    local autoCapsDir  = localAppData .. "\\AutoCaps"
    local exePath      = autoCapsDir .. "\\backend\\transcription_engine.exe"
    local cudaDir      = autoCapsDir .. "\\cuda"
    local modelDir     = autoCapsDir .. "\\models"

    if not pathExists(exePath) then
        itm.StatusLbl.Text = "שגיאה: מנוע לא הותקן!"
        itm.BtnRun.Enabled = true
        return
    end

    local tempDir = os.getenv("TEMP") or "C:\\Windows\\Temp"
    local timestamp = os.date("%Y%m%d_%H%M%S")
    
    local audioOut = tempDir .. "\\autocaps_audio_" .. timestamp .. ".wav"
    local srtOut   = tempDir .. "\\autocaps_subs_" .. timestamp .. ".srt"
    local doneFile = tempDir .. "\\autocaps_done_" .. timestamp .. ".txt"
    local logPath  = tempDir .. "\\autocaps_log_" .. timestamp .. ".txt"
    local batPath  = tempDir .. "\\autocaps_run_" .. timestamp .. ".bat"

    local isInOut = (itm.ComboRange.CurrentText == "inOut")

    -- 1. ייצוא האודיו מריזולב
    local exportOk, exportMsg = exportAudio(audioOut, isInOut)
    if not exportOk then
        itm.StatusLbl.Text = "שגיאה בייצוא: " .. (exportMsg or "")
        itm.BtnRun.Enabled = true
        return
    end

    itm.StatusLbl.Text = "מתחיל תמלול..."

    -- איסוף פרמטרים מהממשק
    local lang     = itm.ComboLang.CurrentText
    local device   = itm.ComboDevice.CurrentText
    local maxWords = itm.SpinWords.Value
    local maxLines = itm.SpinLines.Value
    local rmPunc   = itm.CheckPunctuation.Checked
    local model    = "ivrit-ai/whisper-large-v3-turbo-ct2"

    -- 2. בניית הפקודה ל-EXE
    local cmdArgs = string.format('"%s" "%s" "%s" --language %s --model "%s" --model-dir "%s" --device %s --max-words-per-line %d --max-lines-per-subtitle %d',
        exePath, audioOut, srtOut, lang, model, modelDir, device, maxWords, maxLines)
    
    if rmPunc then
        cmdArgs = cmdArgs .. " --remove-punctuation"
    end

    -- הרצה במצב Unbuffered של פייתון (מבטיח שהאחוזים ייכתבו לקובץ בזמן אמת!)
    local finalCmd = 'set "PATH=' .. cudaDir .. ';%PATH%" && set "CUDA_DIR=' .. cudaDir .. '" && set "PYTHONUNBUFFERED=1" && ' .. cmdArgs .. ' > "' .. logPath .. '" 2>&1 & echo DONE > "' .. doneFile .. '"'

    -- 3. הרצה שקטה לחלוטין ברקע
    execute_silent_async(finalCmd, batPath)

    -- 4. לולאת המתנה שקטה שבודקת מתי התמלול מסתיים ומציגה אחוזים בזמן אמת!
    local timeout = 600 -- 10 דקות גג לתמלול
    while not pathExists(doneFile) and timeout > 0 do
        bmd.wait(1) -- המתנה שאינה תוקעת את דה-וינצ'י
        timeout = timeout - 1

        -- קריאת אחוזים וזמן שנותר מהלוג ומעבר על הנתונים בזמן אמת
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

    -- 5. ייבוא הכתוביות לטיים-ליין או טיפול בשגיאות מהלוג
    if pathExists(srtOut) then
        itm.StatusLbl.Text = "מייבא כתוביות לטיים-ליין..."
        local imported, importMsg = importSrtToTimeline(srtOut)
        
        if imported then
            itm.StatusLbl.Text = "הושלם! " .. importMsg
        else
            -- הצגת הודעת השגיאה למשתמש יחד עם ההוראה הידנית
            itm.StatusLbl.Text = "ייבוא אוטומטי נכשל. גרור את ה-SRT ידנית מתיקיית AutoCaps."
            print("Import Error: " .. (importMsg or ""))
        end
    else
        -- חילוץ שגיאה אמיתית מהלוג אם הקובץ לא נוצר
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

    -- ניקוי קבצים זמניים
    os.remove(audioOut)
    os.remove(doneFile)
    os.remove(batPath)
    
    itm.BtnRun.Enabled = true
end

-- הצגת החלון
win:Show()
disp:RunLoop()
win:Hide()