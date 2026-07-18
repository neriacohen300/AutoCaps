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