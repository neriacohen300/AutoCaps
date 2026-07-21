const { spawn, execFile } = require('child_process');
const fs = require('fs');
const https = require('https');

const csInterface = new CSInterface();
const btnExport = document.getElementById('btnExport');
const statusDiv = document.getElementById('status');

// הוסף קופסת debug מתחת ל-status
const debugDiv = document.createElement('div');
debugDiv.style = "font-size:11px; color:#aaa; margin-top:10px; white-space:pre-wrap; direction:ltr; text-align:left;";
statusDiv.parentNode.appendChild(debugDiv);

function log(msg) {
    console.log(msg);
    //debugDiv.innerText += msg + "\n";
}

function waitForFile(filePath, timeoutMs, onReady, onTimeout) {
    const start = Date.now();
    const interval = setInterval(() => {
        if (fs.existsSync(filePath) && fs.statSync(filePath).size > 0) {
            clearInterval(interval);
            onReady();
        } else if (Date.now() - start > timeoutMs) {
            clearInterval(interval);
            onTimeout();
        }
    }, 500);
}


btnExport.addEventListener('click', async () => {
    debugDiv.innerText = ""; // נקה log קודם
    btnExport.disabled = true;
    statusDiv.innerText = "מייצא אודיו מהטיימליין...";
    
    const language = document.getElementById('language').value;
    const range = document.getElementById('timelineRange').value;
    const maxWords = document.getElementById('maxWords').value;
    const maxLines = document.getElementById('maxLines').value;
    const device = document.getElementById('deviceSelect').value;
    const btnCutSilence = document.getElementById('btnCutSilence');
    const statusSilence = document.getElementById('statusSilence');
    // קריאת המצב של תיבת הסימון החדשה
    const removePunctuation = document.getElementById('removePunctuation').checked;
    // קריאת מילון המונחים המותאם אישית ושמירתו לדיסק לפעם הבאה
    const customVocabulary = document.getElementById('customVocabulary') ? document.getElementById('customVocabulary').value.trim() : "";
    saveCustomVocabulary();

    const audioOutPath = path.join(Config.tempDir, `autocaps_audio_${Date.now()}.wav`);
    const srtOutPath = path.join(Config.tempDir, `autocaps_subs_${Date.now()}.srt`);

    const presetPath = Config.presetPath;
    
    log("audioOutPath: " + audioOutPath);
    log("presetPath: " + presetPath);
    log("range: " + range);
    log("removePunctuation: " + removePunctuation);

    const extendScriptCall = `exportAudioForTranscription("${audioOutPath.replace(/\\/g, '\\\\')}", "${range}", "${presetPath.replace(/\\/g, '\\\\')}")`;
    
    log("Calling ExtendScript...");
    
    csInterface.evalScript(extendScriptCall, (result) => {
        log("ExtendScript result: " + result);
        
        if (result !== "SUCCESS") {
            statusDiv.innerText = "שגיאה בייצוא אודיו: " + result;
            btnExport.disabled = false;
            return;
        }

        // המתן לקובץ WAV להיווצר (עד 60 שניות)
        statusDiv.innerText = "ממתין לייצוא WAV...";
        waitForFile(audioOutPath, 60000, () => {
            log("WAV file ready, size: " + fs.statSync(audioOutPath).size);
            statusDiv.innerText = "מתמלל... (אנא המתן)";
            // העברת removePunctuation וה-customVocabulary כפרמטרים נוספים
            runTranscriptionEngine(audioOutPath, srtOutPath, language, maxWords, maxLines, device, range, removePunctuation, customVocabulary);
        }, () => {
            log("WAV file never appeared!");
            statusDiv.innerText = "שגיאה: קובץ WAV לא נוצר";
            btnExport.disabled = false;
        });
    });
});

function runTranscriptionEngine(audioPath, srtPath, language, maxWords, maxLines, device, range, removePunctuation, customVocabulary) {
    const args = [
        audioPath, srtPath,
        "--language", language,
        "--model", Config.modelName,
        "--model-dir", Config.modelDir,
        "--device", device,
        "--max-words-per-line", maxWords,
        "--max-lines-per-subtitle", maxLines
    ];

    // אם המשתמש סימן את התיבה, נוסיף את דגל הסרת סימני הפיסוק לארגומנטים של ה-EXE
    if (removePunctuation) {
        args.push("--remove-punctuation");
    }

    // אם המשתמש הזין מילון מונחים מותאם אישית, נעביר אותו כ-prompt למודל התמלול
    if (customVocabulary) {
        args.push("--custom-vocabulary", customVocabulary);
    }

    log("EXE path: " + Config.exePath);
    log("EXE exists: " + fs.existsSync(Config.exePath));
    log("Args: " + args.join(" "));

    const env = Object.assign({}, process.env, { 
        CUDA_DIR: Config.cudaDir,
        PYTHONIOENCODING: "utf-8",
        PYTHONUTF8: "1"
    });
    const worker = spawn(Config.exePath, args, { env: env });

    worker.stderr.on('data', (data) => {
        log("stderr: " + data.toString());
    });

    worker.stdout.on('data', (data) => {
        try {
            const lines = data.toString().trim().split('\n');
            lines.forEach(line => {
                const event = JSON.parse(line);
                if (event.event === "segment") {
                    statusDiv.innerText = `מתמלל: ${event.progress_pct}% (נשאר ${event.eta_sec} שניות)`;
                }
            });
        } catch (e) {}
    });

    worker.on('close', (code) => {
        log("EXE exit code: " + code);
        log("SRT exists: " + fs.existsSync(srtPath));
        
        if (code === 0 && fs.existsSync(srtPath)) {
            statusDiv.innerText = "התמלול הסתיים, מייבא לפרמייר...";
            // העברת ה-range לפונקציית הייבוא ב-ExtendScript
            const importScript = `importAndPlaceSRT("${srtPath.replace(/\\/g, '\\\\')}", "${range}")`;
            csInterface.evalScript(importScript, (importResult) => {
                log("Import result: " + importResult);
                statusDiv.innerText = "התהליך הושלם בהצלחה!";
                btnExport.disabled = false;
            });
        } else {
            statusDiv.innerText = "שגיאה בתמלול.";
            btnExport.disabled = false;
        }
    });
}


// פונקציה להרצת FFmpeg ואיתור השקט
function detectSilence(wavPath, outJsonPath, threshold, durationMs, padMs) {
    return new Promise((resolve, reject) => {
        const durationSec = durationMs / 1000.0;
        
        const args = [
            "-i", wavPath,
            "-af", `silencedetect=noise=${threshold}dB:d=${durationSec}`,
            "-f", "null", "-"
        ];
        
        const child = spawn(Config.ffmpegPath, args, { windowsHide: true });
        
        let output = "";
        child.stderr.on("data", data => output += data.toString());
        
        child.on("error", e => reject(new Error("הפעלת FFmpeg נכשלה: " + e.message)));
        
        child.on("close", code => {
            if (code !== 0) {
                return reject(new Error("FFmpeg נכשל (קוד " + code + ")"));
            }
            
            const results = [];
            const lines = output.split('\n');
            let currentStart = null;
            
            for (let i = 0; i < lines.length; i++) {
                const line = lines[i];
                const startMatch = line.match(/silence_start:\s+([\d\.]+)/);
                if (startMatch) currentStart = parseFloat(startMatch[1]);
                
                const endMatch = line.match(/silence_end:\s+([\d\.]+)/);
                if (endMatch && currentStart !== null) {
                    const end = parseFloat(endMatch[1]);
                    const padSec = padMs / 1000.0;
                    
                    const adjStart = currentStart + padSec;
                    const adjEnd = end - padSec;
                    
                    if (adjEnd > adjStart) {
                        results.push({ start: adjStart, end: adjEnd, isSilence: true });
                    }
                    currentStart = null;
                }
            }
            
            try {
                fs.writeFileSync(outJsonPath, JSON.stringify(results, null, 2), "utf8");
                resolve(results);
            } catch (err) {
                reject(new Error("שגיאה בשמירת קובץ ה-JSON: " + err.message));
            }
        });
    });
}

// מאזין ללחיצה על כפתור חיתוך שקט
// הגישה: מייצאים אודיו -> מזהים שקט -> הופכים את קטעי השקט לקטעי "שמירה"
// -> בונים XML חדש שמכיל רק את הקטעים האלה -> מייבאים אותו כסיקוונס חדש.
btnCutSilence.addEventListener('click', () => {
    btnCutSilence.disabled = true;
    statusSilence.innerText = "מייצא אודיו לבדיקה...";

    const wavPath = path.join(Config.tempDir, `silence_scan_${Date.now()}.wav`);
    const exportScript = `exportAudioForTranscription("${wavPath.replace(/\\/g, '\\\\')}", "entire", "${Config.presetPath.replace(/\\/g, '\\\\')}")`;

    csInterface.evalScript(exportScript, async (exportRes) => {
        if (exportRes !== "SUCCESS") {
            statusSilence.innerText = "שגיאה בייצוא האודיו: " + exportRes;
            btnCutSilence.disabled = false;
            return;
        }

        try {
            statusSilence.innerText = "מנתח גלי קול (מאתר שקט)...";
            const threshold = parseFloat(document.getElementById('silThreshold').value);
            const duration = parseFloat(document.getElementById('silDuration').value);
            const pad = parseFloat(document.getElementById('silPad').value);
            const jsonPath = path.join(Config.tempDir, `silence_${Date.now()}.json`);

            const silenceSegments = await detectSilence(wavPath, jsonPath, threshold, duration, pad);

            statusSilence.innerText = "שולף מידע על קליפי הסיקוונס...";
            const seqInfoRaw = await lcEvalJsx("getSequenceClipsInfo()");
            let seqInfo;
            try { seqInfo = JSON.parse(seqInfoRaw); } catch (e) { seqInfo = { ok: false, error: seqInfoRaw }; }
            if (!seqInfo || !seqInfo.ok) {
                throw new Error("שליפת מידע מהסיקוונס נכשלה: " + (seqInfo ? seqInfo.error : seqInfoRaw));
            }

            statusSilence.innerText = "מחשב קטעים לשמירה...";
            const totalDuration = await getMediaDurationSeconds(wavPath);
            if (!totalDuration) {
                throw new Error("לא הצלחתי לקבוע את אורך האודיו הכולל");
            }

            const keepIntervals = computeKeepIntervals(silenceSegments, totalDuration);
            if (keepIntervals.length === 0) {
                throw new Error("לא נמצאו קטעים לשמירה (כל הקטע זוהה כשקט?)");
            }

            // ממפים כל קטע "לשמירה" לקליפ/קובץ המקור הנכון שלו (תומך בכל
            // כמות קליפים על V1, לא רק קליפ בודד)
            const mappedSegments = mapKeepIntervalsToClips(keepIntervals, seqInfo.clips);
            if (mappedSegments.length === 0) {
                throw new Error("לא נמצאה התאמה בין קטעי השמע לקליפים בטיימליין");
            }

            statusSilence.innerText = "בונה XML לייבוא...";
            const xmlContent = buildFcpXml(mappedSegments, seqInfo);
            const xmlPath = path.join(Config.tempDir, `autocaps_cut_${Date.now()}.xml`);
            fs.writeFileSync(xmlPath, xmlContent, 'utf-8');

            statusSilence.innerText = "מייבא סיקוונס חדש עם החיתוכים...";
            const importResRaw = await lcEvalJsx(`importXmlAsNewSequence("${xmlPath.replace(/\\/g, '\\\\')}")`);
            let importRes;
            try { importRes = JSON.parse(importResRaw); } catch (e) { importRes = { ok: false, error: importResRaw }; }

            if (!importRes || !importRes.ok) {
                throw new Error("ייבוא ה-XML נכשל: " + (importRes ? importRes.error : importResRaw));
            }

            statusSilence.innerText = `הושלם! נוצר סיקוונס חדש "${importRes.sequenceName}" עם ${mappedSegments.length} קטעים.` +
                (importRes.openedInPanel ? "" : " (אם הטיימליין לא נפתח אוטומטית, לחצו פעמיים על הסיקוונס בתיקיית AutoCaps בבין הפרויקטים)");
        } catch (err) {
            statusSilence.innerText = "שגיאה: " + err.message;
        } finally {
            btnCutSilence.disabled = false;
        }
    });
});

// מחפש את משך הזמן הכולל (בשניות) של קובץ מדיה באמצעות FFmpeg (דרך פלט ה-stderr
// שמכיל שורת "Duration: HH:MM:SS.xx"), בלי תלות בקובץ ffprobe נפרד.
function getMediaDurationSeconds(filePath) {
    return new Promise((resolve) => {
        try {
            const child = spawn(Config.ffmpegPath, ["-i", filePath], { windowsHide: true });
            let stderrOutput = "";
            child.stderr.on("data", (d) => stderrOutput += d.toString());
            child.on("close", () => {
                const match = stderrOutput.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
                if (match) {
                    const h = parseInt(match[1], 10);
                    const m = parseInt(match[2], 10);
                    const s = parseFloat(match[3]);
                    resolve(h * 3600 + m * 60 + s);
                } else {
                    resolve(null);
                }
            });
            child.on("error", () => resolve(null));
        } catch (e) {
            resolve(null);
        }
    });
}

// ממפה כל קטע "לשמירה" (בציר הזמן הכולל של הסיקוונס, 0-based) לקליפ/קובץ
// המקור המתאים לו. אם קטע "לשמירה" חוצה גבול בין שני קליפים שונים בטיימליין
// (כלומר נמשך על פני נקודת חיתוך קיימת), הוא מפוצל לכמה תת-קטעים - אחד לכל
// קליפ מקור מעורב - כדי שכל תת-קטע ב-XML הסופי יצביע על קובץ ונקודות in/out
// נכונות. clips חייב להיות ממוין לפי seqStart (כפי שמגיע מ-JSX).
function mapKeepIntervalsToClips(keepIntervals, clips) {
    const EPS = 1e-4;
    const sortedClips = clips.slice().sort((a, b) => a.seqStart - b.seqStart);
    const result = [];

    for (const seg of keepIntervals) {
        let cursor = seg.start;
        let guard = 0; // הגנה מפני לולאה אינסופית במקרה של פערים לא צפויים

        while (cursor < seg.end - EPS && guard < 10000) {
            guard++;

            const clip = sortedClips.find(c => cursor >= c.seqStart - EPS && cursor < c.seqEnd - EPS);
            if (!clip) {
                // אין קליפ בטיימליין שמכסה את הרגע הזה (למשל פער/רווח בין
                // קליפים) - מדלגים קדימה לקליפ הבא שמתחיל אחרי הנקודה הזו
                const nextClip = sortedClips.find(c => c.seqStart > cursor + EPS);
                if (!nextClip) break;
                cursor = nextClip.seqStart;
                continue;
            }

            const pieceEnd = Math.min(seg.end, clip.seqEnd);
            if (pieceEnd - cursor > 0.01) {
                result.push({
                    mediaPath: clip.mediaPath,
                    name: clip.name,
                    sourceStart: clip.sourceIn + (cursor - clip.seqStart),
                    sourceEnd: clip.sourceIn + (pieceEnd - clip.seqStart)
                });
            }
            cursor = pieceEnd;
        }
    }

    return result;
}

// הופך רשימת קטעי שקט (silence intervals) לרשימת קטעים ל"שמירה" (הפוך שלהם
// על ציר הזמן המלא [0, totalDuration]). קטעים קצרים מדי (פחות מפריים בערך)
// נזרקים כדי למנוע קליפים באורך אפס ב-XML.
function computeKeepIntervals(silenceIntervals, totalDuration) {
    const MIN_KEEP_SEC = 0.04;
    const keep = [];
    let cursor = 0;

    const sorted = (silenceIntervals || [])
        .filter(seg => seg && seg.isSilence !== false)
        .slice()
        .sort((a, b) => a.start - b.start);

    for (const seg of sorted) {
        if (seg.start > cursor + MIN_KEEP_SEC) {
            keep.push({ start: cursor, end: seg.start });
        }
        if (seg.end > cursor) cursor = seg.end;
    }

    if (totalDuration - cursor > MIN_KEEP_SEC) {
        keep.push({ start: cursor, end: totalDuration });
    }

    return keep;
}

// ממיר קצב פריימים עשרוני (למשל 29.97) לזוג timebase+ntsc כפי שדורש
// פורמט Final Cut Pro XML, ומחזיר גם את קצב הפריימים ה"אמיתי" לחישובי פריימים.
function computeTimebaseAndNtsc(fps) {
    const ntscRates = [
        { rate: 23.976, timebase: 24 },
        { rate: 29.97, timebase: 30 },
        { rate: 59.94, timebase: 60 },
        { rate: 47.952, timebase: 48 }
    ];
    for (const r of ntscRates) {
        if (Math.abs(fps - r.rate) < 0.02) {
            return { timebase: r.timebase, ntsc: true, actualFps: r.timebase * 1000 / 1001 };
        }
    }
    const rounded = Math.round(fps);
    return { timebase: rounded, ntsc: false, actualFps: rounded };
}

// בורח (escape) תווים בעייתיים לפני הכנסה ל-XML
function xmlEscape(str) {
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&apos;');
}

// ממיר נתיב קובץ מקומי (Windows) לכתובת file:// כפי שדורש Final Cut Pro XML
function toFileUrl(filePath) {
    const normalized = filePath.replace(/\\/g, '/');
    const encoded = encodeURI(normalized);
    return 'file://localhost/' + encoded;
}

// בונה מסמך Final Cut Pro XML (xmeml v5) המכיל סיקוונס חדש עם קליפי וידאו+אודיו
// עוקבים - רק לקטעים ב-segments (שכבר מופו לקבצי המקור הנכונים שלהם על ידי
// mapKeepIntervalsToClips). תומך בכמה קבצי מקור שונים, לא רק אחד.
function buildFcpXml(segments, seqInfo) {
    const { timebase, ntsc, actualFps } = computeTimebaseAndNtsc(seqInfo.fps);
    const ntscStr = ntsc ? "TRUE" : "FALSE";
    const secToFrames = (sec) => Math.max(0, Math.round(sec * actualFps));

    // מיפוי נתיב קובץ -> מזהה file-id ייחודי. כל קובץ מקור מוגדר במלואו רק
    // בפעם הראשונה שבה הוא מופיע במסמך; בכל שימוש נוסף (כולל בין וידאו
    // לאודיו של אותו קטע) יש רק הפניה קצרה <file id="..."/>. הגדרה כפולה/לא
    // עקבית של אותו קובץ הייתה אחת הבעיות המרכזיות בגרסה הישנה.
    const fileIdByPath = new Map();
    const definedFileIds = new Set();
    let nextFileNum = 1;

    function getFileId(mediaPath) {
        if (!fileIdByPath.has(mediaPath)) {
            fileIdByPath.set(mediaPath, `file-${nextFileNum++}`);
        }
        return fileIdByPath.get(mediaPath);
    }

    let cursorFrame = 0;
    const videoClipItems = [];
    const audioClipItems = [];

    segments.forEach((seg, idx) => {
        const durationFrames = secToFrames(seg.sourceEnd - seg.sourceStart);
        if (durationFrames <= 0) return;

        const fileId = getFileId(seg.mediaPath);
        const isFirstUseOfFile = !definedFileIds.has(fileId);
        definedFileIds.add(fileId);

        const inFrame = secToFrames(seg.sourceStart);
        const outFrame = inFrame + durationFrames;
        const startFrame = cursorFrame;
        const endFrame = startFrame + durationFrames;

        const i = idx + 1;
        const videoId = `clipitem-v${i}`;
        const audioId = `clipitem-a${i}`;
        const clipDisplayName = xmlEscape(seg.name || "AutoCaps Source");
        const fileUrl = toFileUrl(seg.mediaPath);
        const fileDuration = outFrame + timebase * 60;

        // הבלוק המלא של <file> - בכוונה בלי width/height/samplecharacteristics
        // של וידאו. הצהרה שגויה על רזולוציית המקור (למשל שימוש ברזולוציית
        // הסיקוונס במקום רזולוציית הקובץ האמיתית) היא מה שגרם לבעיית ה-Scale
        // הלא-אחיד (109.4% רוחב מול גובה שונה) בגרסה הקודמת. Premiere קורא
        // את המימדים האמיתיים ישירות מהקובץ בעצמו (הוא קובץ אמיתי וקיים על
        // הדיסק) ולא צריך שנצהיר עליהם כאן.
        const fileBlockFull =
            `<file id="${fileId}">` +
                `<name>${clipDisplayName}</name>` +
                `<pathurl>${xmlEscape(fileUrl)}</pathurl>` +
                `<rate><timebase>${timebase}</timebase><ntsc>${ntscStr}</ntsc></rate>` +
                `<duration>${fileDuration}</duration>` +
                `<media>` +
                    `<video></video>` +
                    `<audio>` +
                        `<samplecharacteristics>` +
                            `<depth>16</depth>` +
                            `<samplerate>48000</samplerate>` +
                        `</samplecharacteristics>` +
                        `<channelcount>2</channelcount>` +
                    `</audio>` +
                `</media>` +
            `</file>`;
        const fileBlockRef = `<file id="${fileId}"/>`;

        const linkBlocks =
            `<link><linkclipref>${videoId}</linkclipref><mediatype>video</mediatype><trackindex>1</trackindex><clipindex>${i}</clipindex></link>` +
            `<link><linkclipref>${audioId}</linkclipref><mediatype>audio</mediatype><trackindex>1</trackindex><clipindex>${i}</clipindex><groupindex>1</groupindex></link>`;

        videoClipItems.push(
            `<clipitem id="${videoId}">` +
                `<name>${clipDisplayName}</name>` +
                `<enabled>TRUE</enabled>` +
                `<duration>${fileDuration}</duration>` +
                `<rate><timebase>${timebase}</timebase><ntsc>${ntscStr}</ntsc></rate>` +
                `<start>${startFrame}</start>` +
                `<end>${endFrame}</end>` +
                `<in>${inFrame}</in>` +
                `<out>${outFrame}</out>` +
                (isFirstUseOfFile ? fileBlockFull : fileBlockRef) +
                linkBlocks +
            `</clipitem>`
        );

        // sourcetrack מציין ל-Premiere לקחת את כל הערוצים של טראק האודיו
        // הראשון בקובץ המקור (בד"כ הזוג הסטריאו המקורי) ולא רק ערוץ שמאל
        // בודד. חוסר האלמנט הזה הוא מה שגרם לתווית "L" להופיע על כל הקליפים
        // בגרסה הקודמת - Premiere נפל חזרה לברירת מחדל של ערוץ יחיד.
        audioClipItems.push(
            `<clipitem id="${audioId}">` +
                `<name>${clipDisplayName}</name>` +
                `<enabled>TRUE</enabled>` +
                `<duration>${fileDuration}</duration>` +
                `<rate><timebase>${timebase}</timebase><ntsc>${ntscStr}</ntsc></rate>` +
                `<start>${startFrame}</start>` +
                `<end>${endFrame}</end>` +
                `<in>${inFrame}</in>` +
                `<out>${outFrame}</out>` +
                fileBlockRef +
                `<sourcetrack><mediatype>audio</mediatype><trackindex>1</trackindex></sourcetrack>` +
                linkBlocks +
            `</clipitem>`
        );

        cursorFrame = endFrame;
    });

    const totalFrames = cursorFrame;
    const seqName = "AutoCaps_SilenceCut_" + Date.now();

    return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE xmeml>
<xmeml version="5">
  <sequence id="sequence-1">
    <name>${xmlEscape(seqName)}</name>
    <duration>${totalFrames}</duration>
    <rate><timebase>${timebase}</timebase><ntsc>${ntscStr}</ntsc></rate>
    <media>
      <video>
        <format>
          <samplecharacteristics>
            <width>${seqInfo.width}</width>
            <height>${seqInfo.height}</height>
            <pixelaspectratio>square</pixelaspectratio>
            <rate><timebase>${timebase}</timebase><ntsc>${ntscStr}</ntsc></rate>
          </samplecharacteristics>
        </format>
        <track>
          ${videoClipItems.join("\n          ")}
        </track>
      </video>
      <audio>
        <format>
          <samplecharacteristics>
            <depth>16</depth>
            <samplerate>48000</samplerate>
          </samplecharacteristics>
          <channelcount>2</channelcount>
        </format>
        <track>
          ${audioClipItems.join("\n          ")}
        </track>
      </audio>
    </media>
  </sequence>
</xmeml>
`;
}




// ==========================================
// 🎙️ עריכת פודקאסט אוטומטית - 2 עד 4 משתתפים + זווית "כולם ביחד" אופציונלית
// כל דובר = טראק וידאו נפרד + טראק אודיו נפרד. המערכת מזהה מי מדבר על פי שקטים
// בכל טראק אודיו בנפרד, ומחליפה אוטומטית בין המצלמות בהתאם.
// ==========================================

function $(id) { return document.getElementById(id); }

// עוטף את csInterface.evalScript ב-Promise כדי לאפשר קוד async/await נקי יותר
function lcEvalJsx(script) {
    return new Promise((resolve) => {
        csInterface.evalScript(script, resolve);
    });
}

// בונה מחדש את שורות "וידאו/אודיו לכל דובר" בממשק, לפי כמות המשתתפים שנבחרה
function renderPodcastSpeakerRows() {
    const count = parseInt($("podSpeakerCount").value, 10);
    const container = $("podSpeakersContainer");
    container.innerHTML = "";

    for (let i = 1; i <= count; i++) {
        const row = document.createElement("div");
        row.className = "field-row";
        row.style.marginTop = "8px";
        row.innerHTML = `
            <div class="field-group">
                <label>וידאו - דובר ${i}</label>
                <input type="number" id="podSpk${i}Vid" value="${i}" min="1">
            </div>
            <div class="field-group">
                <label>אודיו - דובר ${i}</label>
                <input type="number" id="podSpk${i}Aud" value="${i}" min="1">
            </div>
        `;
        container.appendChild(row);
    }
}

$("podSpeakerCount").addEventListener("change", renderPodcastSpeakerRows);
$("podUseMaster").addEventListener("change", () => {
    $("podMasterTrackWrap").style.display = $("podUseMaster").checked ? "flex" : "none";
});
renderPodcastSpeakerRows(); // אתחול ראשוני עם הכמות שנבחרה כברירת מחדל (2)

// ==========================================
// 🎚️ מנוע ניתוח עוצמה (RMS) חלונאי - מחליף את זיהוי השקט הבינארי הישן.
// במקום "שקט/לא שקט" per טראק בנפרד, בונים ציר עוצמה (dB) לכל דובר בחלוני זמן קבועים,
// ולאחר מכן משווים בין הדוברים בו-זמנית כדי לקבוע מי *באמת* דומיננטי בכל רגע.
// זה פותר בעיית "בליד" מיקרופון (דובר שקט נשמע קצת בטראק של דובר אחר) ומאפשר היסטרזיס.
// ==========================================
const ENERGY_WINDOW_MS = 100;      // רזולוציית הדגימה לניתוח עוצמה
const ENERGY_SAMPLE_RATE = 48000;  // קצב דגימה אחיד לצורך חלונות עקביים בין דוברים

function escFfmpegFilterPath(p) {
    return p.replace(/\\/g, '/').replace(/:/g, '\\:');
}

// מריץ FFmpeg על קובץ אודיו של דובר בודד ומחזיר סדרת עוצמות (dB) בחלונות קבועים + משך כולל.
// המטא-דאטה (RMS_level) מודפסת ישירות ל-stderr (ametadata=print בלי file=) כדי להימנע
// מבעיות escaping עדינות בנתיבי Windows (רווחים/עברית/אותיות כונן) שגורמות ל"0 חיתוכים".
function analyzeTrackEnergy(wavPath, uniqueTag) {
    return new Promise((resolve) => {
        if (!fs.existsSync(Config.ffmpegPath)) {
            resolve({ levels: [], duration: 0 });
            return;
        }

        const samplesPerWindow = Math.round(ENERGY_SAMPLE_RATE * (ENERGY_WINDOW_MS / 1000));
        const filter = `aresample=${ENERGY_SAMPLE_RATE},highpass=f=80,asetnsamples=n=${samplesPerWindow},astats=metadata=1:reset=1,ametadata=print:key=lavfi.astats.Overall.RMS_level`;

        const args = ["-i", wavPath, "-af", filter, "-f", "null", "-"];

        execFile(Config.ffmpegPath, args, { maxBuffer: 1024 * 1024 * 64 }, (execErr, stdout, stderr) => {
            const out = (stdout || "") + (stderr || "");

            let duration = 0;
            const mDur = out.match(/Duration:\s+(\d+):(\d+):([\d.]+)/);
            if (mDur) {
                duration = parseInt(mDur[1], 10) * 3600 + parseInt(mDur[2], 10) * 60 + parseFloat(mDur[3]);
            }

            const levels = [];
            const lines = out.split("\n");
            let pendingTime = null;
            for (let i = 0; i < lines.length; i++) {
                const mTime = lines[i].match(/pts_time:([\d.]+)/);
                if (mTime) { pendingTime = parseFloat(mTime[1]); continue; }
                const mLvl = lines[i].match(/RMS_level=(-?[\d.]+|-?inf|nan)/i);
                if (mLvl && pendingTime !== null) {
                    let val = parseFloat(mLvl[1]);
                    if (isNaN(val)) val = -100; // "-inf"/"nan" = שקט דיגיטלי מוחלט
                    levels.push({ t: pendingTime, db: val });
                    pendingTime = null;
                }
            }

            resolve({ levels, duration });
        });
    });
}

// בונה מפת "מי על המצלמה" לאורך זמן, על בסיס השוואת עוצמה בין כל הדוברים + היסטרזיס.
// היסטרזיס = מתמודד צריך להיות חזק יותר במרווח בטוח (MARGIN_DB) ולהחזיק מעמד (CHALLENGER_HOLD_MS)
// לפני שהמצלמה עוברת אליו. זה מונע קאטים עצבניים מ"מממ", צחוק קצר, או בליד מיקרופון.
function buildActiveSpeakerTimeline(speakers, masterVidTrack, floorDb, silenceHoldMs, marginDb, holdMs) {
    const windowSec = ENERGY_WINDOW_MS / 1000.0;
    const maxDuration = Math.max.apply(null, speakers.map(s => s.duration || 0));
    const totalWindows = Math.ceil(maxDuration / windowSec);

    function levelAt(spk, winIdx) {
        const targetT = winIdx * windowSec;
        if (spk.levels[winIdx] && Math.abs(spk.levels[winIdx].t - targetT) < windowSec) {
            return spk.levels[winIdx].db;
        }
        for (let i = 0; i < spk.levels.length; i++) {
            if (Math.abs(spk.levels[i].t - targetT) < windowSec) return spk.levels[i].db;
        }
        return -100;
    }

    const initialTrack = (masterVidTrack !== null) ? masterVidTrack : speakers[0].videoTrack;
    let currentTrack = initialTrack;
    let currentHolderIdx = -1; // -1 = על מצלמת ברירת מחדל/מאסטר, לא דובר ספציפי כרגע
    let challengerIdx = -1;
    let challengerStreakMs = 0;
    let silenceStreakMs = 0;

    const segments = [];
    let segStart = 0;

    function pushSegment(endTime) {
        if (endTime - segStart < 0.001) return;
        if (segments.length > 0 && segments[segments.length - 1].activeVidTrack === currentTrack) {
            segments[segments.length - 1].end = endTime;
        } else {
            segments.push({ start: segStart, end: endTime, activeVidTrack: currentTrack });
        }
        segStart = endTime;
    }

    for (let w = 0; w < totalWindows; w++) {
        const t = w * windowSec;

        let bestIdx = -1, bestDb = -100;
        for (let i = 0; i < speakers.length; i++) {
            const db = levelAt(speakers[i], w);
            if (db > bestDb) { bestDb = db; bestIdx = i; }
        }
        const someoneTalking = bestIdx !== -1 && bestDb > floorDb;

        if (!someoneTalking) {
            silenceStreakMs += ENERGY_WINDOW_MS;
            challengerStreakMs = 0;
            challengerIdx = -1;
            if (masterVidTrack !== null && silenceStreakMs >= silenceHoldMs && currentTrack !== masterVidTrack) {
                pushSegment(t);
                currentTrack = masterVidTrack;
                currentHolderIdx = -1;
            }
            // בלי מאסטר - נשארים על המצלמה האחרונה גם בשקט קצר, כדי לא לרפרר
        } else {
            silenceStreakMs = 0;
            const candidateVid = speakers[bestIdx].videoTrack;

            if (candidateVid === currentTrack) {
                challengerStreakMs = 0;
                challengerIdx = -1;
                currentHolderIdx = bestIdx;
            } else {
                if (bestIdx === challengerIdx) {
                    challengerStreakMs += ENERGY_WINDOW_MS;
                } else {
                    challengerIdx = bestIdx;
                    challengerStreakMs = ENERGY_WINDOW_MS;
                }

                const currentHolderDb = (currentHolderIdx >= 0) ? levelAt(speakers[currentHolderIdx], w) : floorDb;
                const strongEnough = (currentHolderIdx === -1) || ((bestDb - currentHolderDb) >= marginDb);

                if (challengerStreakMs >= holdMs && strongEnough) {
                    pushSegment(t);
                    currentTrack = candidateVid;
                    currentHolderIdx = bestIdx;
                    challengerIdx = -1;
                    challengerStreakMs = 0;
                }
            }
        }
    }

    pushSegment(maxDuration);
    return segments;
}

let podcastBusy = false;

async function runPodcastDirector() {
    if (podcastBusy) {
        alert("עריכת הפודקאסט כבר רצה כרגע. אנא המתן לסיום.");
        return;
    }
    podcastBusy = true;

    const btn = $("btnPodcastDirector");
    const statusDiv = $("statusPodcast");
    const progressWrap = $("podcastProgressWrap");
    const barFill = $("barFillPodcast");
    const statusLine = $("statusLinePodcast");

    btn.disabled = true;
    progressWrap.classList.remove("hidden");

    function setProgress(text, pct) {
        statusLine.textContent = text;
        if (typeof pct === "number") {
            barFill.style.width = Math.max(0, Math.min(100, pct)) + "%";
        }
    }

    try {
        // --- קריאת הגדרות מהממשק ---
        const speakerCount = parseInt($("podSpeakerCount").value, 10);
        const useMaster = $("podUseMaster").checked;
        const masterVidTrack = useMaster ? (parseInt($("podMasterVid").value, 10) - 1) : null;

        const threshold = parseFloat($("podThreshold").value);
        const minSilenceMs = parseFloat($("podMinSilence").value);
        const minSilenceSec = minSilenceMs / 1000.0;
        const minShotDuration = parseFloat($("podMinShot").value);
        const marginDb = parseFloat($("podMarginDb").value);
        const holdMs = parseFloat($("podHoldMs").value);

        if (speakerCount < 2 || speakerCount > 4) {
            throw new Error("נתמכים בין 2 ל-4 משתתפים בלבד");
        }

        const speakers = [];
        for (let i = 1; i <= speakerCount; i++) {
            speakers.push({
                videoTrack: parseInt($("podSpk" + i + "Vid").value, 10) - 1,
                audioTrack: parseInt($("podSpk" + i + "Aud").value, 10) - 1
            });
        }

        statusDiv.innerText = "מייצא ומנתח אודיו לכל דובר...";
        const uniqueID = Date.now();

        // --- שלב 1: ייצוא וניתוח אודיו לכל דובר בנפרד (טראק אודיו נפרד לכל דובר) ---
        for (let i = 0; i < speakers.length; i++) {
            const spk = speakers[i];
            const wavPath = path.join(Config.tempDir, `pod_spk${i + 1}_${uniqueID}.wav`);

            setProgress(`מייצא אודיו - דובר ${i + 1}...`, (i / speakers.length) * 40);
            const exportScript = `lcExportSingleTrackAudio("${wavPath.replace(/\\/g, '\\\\')}", "${Config.presetPath.replace(/\\/g, '\\\\')}", 0, ${spk.audioTrack})`;
            const exportResRaw = await lcEvalJsx(exportScript);

            let exportRes;
            try { exportRes = JSON.parse(exportResRaw); } catch (e) { exportRes = { ok: false, error: exportResRaw }; }
            if (!exportRes || !exportRes.ok) {
                throw new Error(`ייצוא אודיו לדובר ${i + 1} נכשל: ${exportRes ? exportRes.error : exportResRaw}`);
            }

            setProgress(`מנתח עוצמת קול - דובר ${i + 1}...`, (i / speakers.length) * 40 + 10);
            const analysis = await analyzeTrackEnergy(wavPath, `spk${i + 1}_${uniqueID}`);
            spk.levels = analysis.levels;
            spk.duration = analysis.duration;

            if (!spk.levels || spk.levels.length === 0) {
                throw new Error(`ניתוח עוצמת קול לדובר ${i + 1} לא החזיר נתונים - בדוק את נתיב FFmpeg (${Config.ffmpegPath})`);
            }

            try { fs.unlinkSync(wavPath); } catch (e) {}
        }

        // --- שלב 2+3: בניית מפת חיתוכים לפי דובר דומיננטי (השוואת עוצמה + היסטרזיס) ---
        // threshold = "רצפת" עוצמה (dB) שמתחתיה נחשב שקט. minSilenceMs = כמה שקט רציף
        // נדרש לפני מעבר לזווית "כולם ביחד"/מאסטר, כדי לא לקפוץ אליה על הפסקת נשימה קצרה.
        setProgress("מחשב מפת חיתוכים...", 45);
        const cutsMap = buildActiveSpeakerTimeline(speakers, masterVidTrack, threshold, minSilenceMs, marginDb, holdMs);

        // --- שלב 4: מעבר החלקה - מיזוג שוטים קצרים מדי שעדיין נשארו (רשת ביטחון אחרונה) ---
        setProgress("מחליק חיתוכים קצרים מדי...", 70);
        let needsAnotherPass = true;
        while (needsAnotherPass) {
            needsAnotherPass = false;
            for (let k = 1; k < cutsMap.length - 1; k++) {
                const cut = cutsMap[k];
                const dur = cut.end - cut.start;
                if (dur < minShotDuration) {
                    const prevCut = cutsMap[k - 1];
                    const nextCut = cutsMap[k + 1];
                    if (prevCut.activeVidTrack === nextCut.activeVidTrack) {
                        prevCut.end = nextCut.end;
                        cutsMap.splice(k, 2);
                    } else {
                        prevCut.end = cut.end;
                        cutsMap.splice(k, 1);
                        nextCut.start = prevCut.end;
                    }
                    needsAnotherPass = true;
                    break;
                }
            }
        }

        // --- שלב 5: יישום החיתוכים בטיימליין בפרימייר ---
        setProgress("מבצע חיתוכים בטיימליין...", 90);
        const involvedTracks = speakers.map((s) => s.videoTrack);
        if (masterVidTrack !== null) involvedTracks.push(masterVidTrack);

        const payload = { tracks: involvedTracks, cuts: cutsMap };
        const jsonStr = JSON.stringify(payload).replace(/'/g, "\\'");
        const applyScript = `lcApplyPodcastEditsGeneric('${jsonStr}')`;

        const applyResultRaw = await lcEvalJsx(applyScript);
        let applyResult;
        try { applyResult = JSON.parse(applyResultRaw); } catch (e) { applyResult = { ok: false, error: applyResultRaw }; }

        if (!applyResult || !applyResult.ok) {
            throw new Error(applyResult ? applyResult.error : "שגיאה לא ידועה ביישום החיתוכים");
        }

        setProgress("הושלם!", 100);
        statusDiv.innerText = `עריכת הפודקאסט הושלמה בהצלחה! (${cutsMap.length} חיתוכים)`;

    } catch (error) {
        statusDiv.innerText = "שגיאה: " + error.message;
        setProgress("שגיאה בתהליך", 0);
        alert("שגיאה בעריכת הפודקאסט: " + error.message);
    } finally {
        podcastBusy = false;
        btn.disabled = false;
    }
}

$("btnPodcastDirector").addEventListener("click", runPodcastDirector);



const btnAutoZoom = document.getElementById('btnAutoZoom');
const statusZoom = document.getElementById('statusZoom');

if (btnAutoZoom) {
    btnAutoZoom.addEventListener('click', async () => {
        btnAutoZoom.disabled = true;
        statusZoom.style.color = "var(--text-primary)";
        
        const trigger = document.getElementById('zoomTrigger').value;
        const intensity = parseFloat(document.getElementById('zoomIntensity').value);

        if (trigger === "clips") {
            statusZoom.innerText = "מחיל זום לסירוגין על הקליפים בטיימליין...";
            const payload = { mode: "clips", intensity: intensity };
            const script = `applySmartAutoZooms('${JSON.stringify(payload).replace(/'/g, "\\'")}')`;
            
            csInterface.evalScript(script, handleZoomResult);
        } 
        else if (trigger === "audio") {
            statusZoom.innerText = "מייצא אודיו לניתוח (שלב 1/3)...";
            const wavPath = path.join(Config.tempDir, `zoom_audio_${Date.now()}.wav`);
            
            // ייצוא אודיו (משתמש ב-Preset שלך)
            const exportScript = `exportAudioForTranscription("${wavPath.replace(/\\/g, '\\\\')}", "entire", "${Config.presetPath.replace(/\\/g, '\\\\')}")`;
            
            csInterface.evalScript(exportScript, async (exportRes) => {
                if (exportRes !== "SUCCESS") {
                    statusZoom.innerText = "שגיאה בייצוא האודיו מפרימייר.";
                    btnAutoZoom.disabled = false;
                    return;
                }
                
                statusZoom.innerText = "מנתח גלי קול ומשפטים (שלב 2/3)...";
                try {
                    const jsonPath = path.join(Config.tempDir, `zoom_silence_${Date.now()}.json`);
                    // משתמש בפונקציית detectSilence שכבר כתבנו קודם לחיתוך שקט
                    // סף -35dB למשך 200ms מהווה זיהוי מצוין של הפרדה בין משפטים
                    const silences = await detectSilence(wavPath, jsonPath, -35, 200, 50); 
                    
                    statusZoom.innerText = "מחיל זומים מסונכרנים לדיבור (שלב 3/3)...";
                    const payload = { mode: "audio", intensity: intensity, silences: silences };
                    const script = `applySmartAutoZooms('${JSON.stringify(payload).replace(/'/g, "\\'")}')`;
                    
                    csInterface.evalScript(script, handleZoomResult);
                } catch(e) {
                    statusZoom.innerText = "שגיאה בניתוח האודיו.";
                    btnAutoZoom.disabled = false;
                }
            });
        }
    });
}

function handleZoomResult(res) {
    btnAutoZoom.disabled = false;
    try {
        const result = JSON.parse(res);
        if (result.ok) {
            statusZoom.innerText = `הושלם בהצלחה! הוחל על ${result.count} אלמנטים.`;
            statusZoom.style.color = "#4CAF50";
        } else {
            statusZoom.innerText = "שגיאה: " + result.error;
            statusZoom.style.color = "#F44336";
        }
    } catch (e) {
        statusZoom.innerText = "שגיאה לא ידועה.";
    }
}

// =========================================================================
// בדיקת גרסה ועדכונים אוטומטית מ-GitHub
// =========================================================================

const versionTag = document.getElementById('versionTag');
const updateBanner = document.getElementById('updateBanner');
const updateBannerText = document.getElementById('updateBannerText');
const btnUpdateDownload = document.getElementById('btnUpdateDownload');

if (versionTag) {
    versionTag.innerText = "v" + Config.version;
}

// השוואת שתי גרסאות בפורמט semver (למשל "1.2.0" מול "1.10.0")
// מחזיר true אם remoteVersion חדשה יותר מ-localVersion
function isNewerVersion(remoteVersion, localVersion) {
    const clean = (v) => v.replace(/^v/i, '').split('.').map(n => parseInt(n, 10) || 0);
    const remote = clean(remoteVersion);
    const local = clean(localVersion);
    const len = Math.max(remote.length, local.length);
    for (let i = 0; i < len; i++) {
        const r = remote[i] || 0;
        const l = local[i] || 0;
        if (r > l) return true;
        if (r < l) return false;
    }
    return false;
}

function openExternalUrl(url) {
    try {
        // הדרך המומלצת ב-CEP לפתיחת קישור בדפדפן ברירת המחדל
        if (csInterface && csInterface.openURLInDefaultBrowser) {
            csInterface.openURLInDefaultBrowser(url);
        } else {
            require('electron').shell.openExternal(url);
        }
    } catch (e) {
        log("Failed to open URL: " + e.message);
    }
}

function checkForUpdates() {
    if (!Config.githubOwner || !Config.githubRepo) return;

    const options = {
        hostname: 'api.github.com',
        path: `/repos/${Config.githubOwner}/${Config.githubRepo}/releases/latest`,
        method: 'GET',
        headers: {
            'User-Agent': 'AutoCaps-Extension',
            'Accept': 'application/vnd.github+json'
        },
        timeout: 8000
    };

    const req = https.request(options, (res) => {
        let body = '';
        res.on('data', (chunk) => body += chunk);
        res.on('end', () => {
            try {
                if (res.statusCode !== 200) {
                    log("Update check: GitHub API returned status " + res.statusCode);
                    return;
                }
                const release = JSON.parse(body);
                const latestVersion = release.tag_name || release.name;
                const releaseUrl = release.html_url || `https://github.com/${Config.githubOwner}/${Config.githubRepo}/releases/latest`;

                if (latestVersion && isNewerVersion(latestVersion, Config.version)) {
                    showUpdateBanner(latestVersion, releaseUrl);
                }
            } catch (e) {
                log("Update check parse error: " + e.message);
            }
        });
    });

    req.on('error', (e) => log("Update check failed: " + e.message));
    req.on('timeout', () => req.destroy());
    req.end();
}

function showUpdateBanner(latestVersion, releaseUrl) {
    if (!updateBanner) return;
    updateBannerText.innerText = `קיימת גרסה חדשה של AutoCaps (${latestVersion.replace(/^v/i, '')})! הגרסה שלכם: ${Config.version}`;
    updateBanner.classList.remove('hidden');
    btnUpdateDownload.onclick = () => openExternalUrl(releaseUrl);
}

// בדיקת עדכונים בעת פתיחת הפאנל
checkForUpdates();


// =========================================================================
// מילון מונחים מותאם אישית (Custom Vocabulary) לתמלול
// =========================================================================

const customVocabularyField = document.getElementById('customVocabulary');

// טעינת המילון השמור מהדיסק, אם קיים
function loadCustomVocabulary() {
    if (!customVocabularyField) return;
    try {
        if (fs.existsSync(Config.vocabularyPath)) {
            const raw = fs.readFileSync(Config.vocabularyPath, 'utf-8');
            const data = JSON.parse(raw);
            customVocabularyField.value = data.text || "";
        }
    } catch (e) {
        log("Failed to load custom vocabulary: " + e.message);
    }
}

// שמירת המילון לדיסק כדי שיישאר בין הפעלות
function saveCustomVocabulary() {
    if (!customVocabularyField) return;
    try {
        const dir = path.dirname(Config.vocabularyPath);
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }
        fs.writeFileSync(Config.vocabularyPath, JSON.stringify({ text: customVocabularyField.value }, null, 2), 'utf-8');
    } catch (e) {
        log("Failed to save custom vocabulary: " + e.message);
    }
}

if (customVocabularyField) {
    loadCustomVocabulary();
    // שמירה אוטומטית בכל פעם שהמשתמש עוזב את השדה
    customVocabularyField.addEventListener('blur', saveCustomVocabulary);
}
