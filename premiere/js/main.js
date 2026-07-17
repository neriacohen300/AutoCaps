const { spawn, execFile } = require('child_process');
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

// מריץ FFmpeg על קובץ אודיו של דובר בודד, ומחזיר גם משך כולל וגם רשימת קטעי שקט
function analyzeTrackSilence(wavPath, thresholdDb, minSilenceSec) {
    return new Promise((resolve, reject) => {
        if (!fs.existsSync(Config.ffmpegPath)) {
            reject(new Error("FFmpeg לא נמצא בנתיב: " + Config.ffmpegPath));
            return;
        }
        const args = [
            "-i", wavPath,
            "-af", `silencedetect=noise=${thresholdDb}dB:d=${minSilenceSec}`,
            "-f", "null", "-"
        ];
        execFile(Config.ffmpegPath, args, (execErr, stdout, stderr) => {
            const out = (stdout || "") + (stderr || "");

            let duration = 0;
            const mDur = out.match(/Duration:\s+(\d+):(\d+):([\d.]+)/);
            if (mDur) {
                duration = parseInt(mDur[1], 10) * 3600 + parseInt(mDur[2], 10) * 60 + parseFloat(mDur[3]);
            }

            const silences = [];
            const lines = out.split("\n");
            let currentStart = null;
            for (let i = 0; i < lines.length; i++) {
                const mStart = lines[i].match(/silence_start:\s+([\d.]+)/);
                if (mStart) currentStart = parseFloat(mStart[1]);

                const mEnd = lines[i].match(/silence_end:\s+([\d.]+)/);
                if (mEnd && currentStart !== null) {
                    silences.push({ start: currentStart, end: parseFloat(mEnd[1]) });
                    currentStart = null;
                }
            }
            if (currentStart !== null && duration > currentStart) {
                silences.push({ start: currentStart, end: duration });
            }

            resolve({ silences, duration });
        });
    });
}

function isSilentAt(time, silenceArray) {
    for (let i = 0; i < silenceArray.length; i++) {
        if (time >= silenceArray[i].start && time <= silenceArray[i].end) return true;
    }
    return false;
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

            setProgress(`מנתח שקט - דובר ${i + 1}...`, (i / speakers.length) * 40 + 10);
            const analysis = await analyzeTrackSilence(wavPath, threshold, minSilenceSec);
            spk.silences = analysis.silences;
            spk.duration = analysis.duration;

            try { fs.unlinkSync(wavPath); } catch (e) {}
        }

        // --- שלב 2: בניית ציר זמן אירועים משותף (כל תחילות/סופי שקט + משכי הטראקים) ---
        setProgress("מחשב מפת חיתוכים...", 45);
        const events = [0];
        speakers.forEach((spk) => {
            if (spk.duration > 0 && events.indexOf(spk.duration) === -1) events.push(spk.duration);
            spk.silences.forEach((s) => {
                if (events.indexOf(s.start) === -1) events.push(s.start);
                if (events.indexOf(s.end) === -1) events.push(s.end);
            });
        });
        events.sort((a, b) => a - b);

        // --- שלב 3: קביעת מצלמה פעילה לכל קטע זמן ---
        // דובר יחיד מדבר -> המצלמה שלו. אף אחד/כמה דוברים ביחד -> זווית "כולם ביחד" אם קיימת, אחרת נשארים על המצלמה האחרונה.
        const cutsMap = [];
        let lastCamera = (masterVidTrack !== null) ? masterVidTrack : speakers[0].videoTrack;

        for (let i = 0; i < events.length - 1; i++) {
            const chunkStart = events[i];
            const chunkEnd = events[i + 1];
            if (chunkEnd - chunkStart < 0.05) continue;

            const midPoint = (chunkStart + chunkEnd) / 2.0;
            const activeSpeakers = speakers.filter((spk) => !isSilentAt(midPoint, spk.silences));

            let chosenVidTrack;
            if (activeSpeakers.length === 1) {
                chosenVidTrack = activeSpeakers[0].videoTrack;
            } else {
                // 0 דוברים או כמה דוברים בו-זמנית
                chosenVidTrack = (masterVidTrack !== null) ? masterVidTrack : lastCamera;
            }

            lastCamera = chosenVidTrack;

            if (cutsMap.length > 0 && cutsMap[cutsMap.length - 1].activeVidTrack === chosenVidTrack) {
                cutsMap[cutsMap.length - 1].end = chunkEnd;
            } else {
                cutsMap.push({ start: chunkStart, end: chunkEnd, activeVidTrack: chosenVidTrack });
            }
        }

        // --- שלב 4: מעבר החלקה - מיזוג שוטים קצרים מדי כדי למנוע קאטים עצבניים ---
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