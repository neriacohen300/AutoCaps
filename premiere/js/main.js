const { spawn } = require('child_process');
const fs = require('fs');

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
            // העברת removePunctuation כפרמטר נוסף
            runTranscriptionEngine(audioOutPath, srtOutPath, language, maxWords, maxLines, device, range, removePunctuation);
        }, () => {
            log("WAV file never appeared!");
            statusDiv.innerText = "שגיאה: קובץ WAV לא נוצר";
            btnExport.disabled = false;
        });
    });
});

function runTranscriptionEngine(audioPath, srtPath, language, maxWords, maxLines, device, range, removePunctuation) {
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
btnCutSilence.addEventListener('click', () => {
    btnCutSilence.disabled = true;
    statusSilence.innerText = "מייצא אודיו לבדיקה...";
    
    // נייצר קובץ אודיו ייעודי בתיקיית ה-Temp
    const wavPath = path.join(Config.tempDir, `silence_scan_${Date.now()}.wav`);
    
    // אנו נשתמש בפונקציה הקיימת ב-JSX לייצוא (חובה קובץ Preset)
    // שים לב ש-exportAudioForTranscription כבר קיימת אצלך בקוד (כמו שרואים מה-metadata של הקובץ)
    const exportScript = `exportAudioForTranscription("${wavPath.replace(/\\/g, '\\\\')}", "entire", "${Config.presetPath.replace(/\\/g, '\\\\')}")`;
    
    csInterface.evalScript(exportScript, async (exportRes) => {
        if (exportRes !== "SUCCESS") {
            statusSilence.innerText = "שגיאה בייצוא האודיו: " + exportRes;
            btnCutSilence.disabled = false;
            return;
        }

        statusSilence.innerText = "מנתח גלי קול (מאתר שקט)...";
        try {
            const threshold = parseFloat(document.getElementById('silThreshold').value);
            const duration = parseFloat(document.getElementById('silDuration').value);
            const pad = parseFloat(document.getElementById('silPad').value);
            const jsonPath = path.join(Config.tempDir, `silence_${Date.now()}.json`);
            
            const segments = await detectSilence(wavPath, jsonPath, threshold, duration, pad);
            const intervalsJson = JSON.stringify(segments);
            
            statusSilence.innerText = "מבצע חיתוכים ומנקה שאריות...";
            
            const cutScript = `cutSilence('${intervalsJson}')`;
            csInterface.evalScript(cutScript, (cutResultRaw) => {
                let cutResult;
                try {
                    cutResult = JSON.parse(cutResultRaw);
                } catch (e) {
                    cutResult = { ok: false, error: cutResultRaw };
                }
                
                if (cutResult && cutResult.ok) {
                    statusSilence.innerText = "הושלם";
                } else {
                    statusSilence.innerText = "שגיאה: " + (cutResult.error || cutResult.message);
                }
                btnCutSilence.disabled = false;
            });
        } catch(err) {
            statusSilence.innerText = "שגיאה בתהליך: " + err.message;
            btnCutSilence.disabled = false;
        }
    });
});