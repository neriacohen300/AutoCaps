const { spawn } = require('child_process');
const fs = require('fs');

const csInterface = new CSInterface();
const btnExport = document.getElementById('btnExport');
const statusDiv = document.getElementById('status');
const versionTag = document.getElementById('versionTag');

const debugDiv = document.createElement('div');
debugDiv.style = "font-size:11px; color:#aaa; margin-top:10px; white-space:pre-wrap; direction:ltr; text-align:left;";
statusDiv.parentNode.appendChild(debugDiv);

if (versionTag) versionTag.innerText = "v" + Config.version;

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

// ------------------------------------------
// מילון מונחים מותאם אישית - שמירה/טעינה מדיסק (זהה בהתנהגות לגרסת פרימייר)
// ------------------------------------------
function saveCustomVocabulary() {
    try {
        const el = document.getElementById('customVocabulary');
        if (!el) return;
        fs.writeFileSync(Config.vocabularyPath, JSON.stringify({ text: el.value }), 'utf-8');
    } catch (e) {
        log("Failed to save vocabulary: " + e.toString());
    }
}

function loadCustomVocabulary() {
    try {
        if (fs.existsSync(Config.vocabularyPath)) {
            const data = JSON.parse(fs.readFileSync(Config.vocabularyPath, 'utf-8'));
            const el = document.getElementById('customVocabulary');
            if (el && data.text) el.value = data.text;
        }
    } catch (e) {
        log("Failed to load vocabulary: " + e.toString());
    }
}
loadCustomVocabulary();

// ------------------------------------------
// זרימת העבודה הראשית: רינדור אודיו (Render Queue) -> תמלול -> יצירת שכבת כתוביות
// ------------------------------------------
btnExport.addEventListener('click', async () => {
    debugDiv.innerText = "";
    btnExport.disabled = true;
    statusDiv.innerText = "מרנדר אודיו מהקומפוזיציה...";

    const language = document.getElementById('language').value;
    const range = document.getElementById('timelineRange').value;
    const maxWords = document.getElementById('maxWords').value;
    const maxLines = document.getElementById('maxLines').value;
    const device = document.getElementById('deviceSelect').value;
    const removePunctuation = document.getElementById('removePunctuation').checked;
    const customVocabulary = document.getElementById('customVocabulary') ? document.getElementById('customVocabulary').value.trim() : "";
    saveCustomVocabulary();

    const audioOutPath = path.join(Config.tempDir, `autocaps_audio_${Date.now()}.wav`);
    const srtOutPath = path.join(Config.tempDir, `autocaps_subs_${Date.now()}.srt`);

    log("audioOutPath: " + audioOutPath);
    log("range: " + range);
    log("removePunctuation: " + removePunctuation);

    const escapedAudioPath = audioOutPath.replace(/\\/g, '\\\\');
    const escapedTemplate = Config.audioOutputModuleTemplate.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    const extendScriptCall = `exportAudioForTranscription("${escapedAudioPath}", "${range}", "${escapedTemplate}")`;

    log("Calling ExtendScript (render queue export)...");

    csInterface.evalScript(extendScriptCall, (result) => {
        log("ExtendScript result: " + result);

        if (result === "ERROR_NO_COMP") {
            statusDiv.innerText = "שגיאה: פתחו קומפוזיציה פעילה לפני היצוא.";
            btnExport.disabled = false;
            return;
        }

        if (typeof result === "string" && result.indexOf("ERROR_AOM_TEMPLATE_NOT_FOUND") === 0) {
            statusDiv.innerText = "שגיאה: תבנית ה-Output Module '" + Config.audioOutputModuleTemplate + "' לא מותקנת ב-After Effects. טענו אותה דרך Edit > Templates > Output Module.";
            btnExport.disabled = false;
            return;
        }

        if (result !== "SUCCESS") {
            statusDiv.innerText = "שגיאה ברינדור אודיו: " + result;
            btnExport.disabled = false;
            return;
        }

        statusDiv.innerText = "ממתין לקובץ WAV...";
        waitForFile(audioOutPath, 120000, () => {
            log("WAV file ready, size: " + fs.statSync(audioOutPath).size);
            statusDiv.innerText = "מתמלל... (אנא המתן)";
            runTranscriptionEngine(audioOutPath, srtOutPath, language, maxWords, maxLines, device, range, removePunctuation, customVocabulary);
        }, () => {
            log("WAV file never appeared!");
            statusDiv.innerText = "שגיאה: קובץ WAV לא נוצר (בדקו שהרינדור הסתיים ב-AE)";
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

    if (removePunctuation) {
        args.push("--remove-punctuation");
    }
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
            statusDiv.innerText = "התמלול הסתיים, יוצר שכבת כתוביות...";
            const escapedSrt = srtPath.replace(/\\/g, '\\\\');
            const captionScript = `createDynamicCaptionLayer("${escapedSrt}", "${range}")`;
            csInterface.evalScript(captionScript, (captionResult) => {
                log("Caption layer result: " + captionResult);
                let parsed = null;
                try { parsed = JSON.parse(captionResult); } catch (e) {}

                if (parsed && parsed.ok) {
                    statusDiv.innerText = `הושלם! נוצרו ${parsed.count} כתוביות בשכבה חדשה.`;
                } else {
                    statusDiv.innerText = "שגיאה ביצירת שכבת הכתוביות: " + (parsed ? parsed.error : captionResult);
                }
                btnExport.disabled = false;
            });
        } else {
            statusDiv.innerText = "שגיאה בתמלול.";
            btnExport.disabled = false;
        }
    });
}


// ------------------------------------------
// עדכון עיצוב לכל הכתוביות הקיימות
// ------------------------------------------
function hexToRgbArray(hex) {
    hex = hex.replace('#', '');
    const r = parseInt(hex.substring(0, 2), 16) / 255;
    const g = parseInt(hex.substring(2, 4), 16) / 255;
    const b = parseInt(hex.substring(4, 6), 16) / 255;
    return [r, g, b];
}

const btnRestyle = document.getElementById('btnRestyle');
const statusRestyle = document.getElementById('statusRestyle');

if (btnRestyle) {
    btnRestyle.addEventListener('click', () => {
        btnRestyle.disabled = true;
        statusRestyle.innerText = "מעדכן עיצוב...";

        const fontFamily = document.getElementById('capFontFamily').value.trim();
        const fontSize = parseInt(document.getElementById('capFontSize').value, 10);
        const fillColor = hexToRgbArray(document.getElementById('capFillColor').value);
        const applyStroke = document.getElementById('capApplyStroke').checked;
        const strokeColor = hexToRgbArray(document.getElementById('capStrokeColor').value);
        const strokeWidth = applyStroke ? parseFloat(document.getElementById('capStrokeWidth').value) : 0;

        const script = `restyleAllCaptions(${fontSize}, ${JSON.stringify(fillColor)}, ${JSON.stringify(strokeColor)}, ${strokeWidth}, "${fontFamily.replace(/"/g, '')}")`;

        csInterface.evalScript(script, (result) => {
            log("Restyle result: " + result);
            let parsed = null;
            try { parsed = JSON.parse(result); } catch (e) {}

            if (parsed && parsed.ok) {
                statusRestyle.innerText = `עודכנו ${parsed.count} כתוביות בהצלחה.`;
            } else {
                statusRestyle.innerText = "שגיאה: " + (parsed ? parsed.error : result);
            }
            btnRestyle.disabled = false;
        });
    });
}
