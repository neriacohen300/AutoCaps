function exportAudioForTranscription(outputPath, rangeType, presetPath) {
    try {
        var seq = app.project.activeSequence;
        if (!seq) return "ERROR_NO_SEQUENCE";

        var epr = new File(presetPath);
        if (!epr.exists) return "ERROR_EPR_NOT_FOUND:" + presetPath;

        var wa = (rangeType === "inOut") ? 1 : 0;

        var outFile = new File(outputPath);
        if (outFile.exists) { outFile.remove(); }

        var res = seq.exportAsMediaDirect(outFile.fsName, epr.fsName, wa);

        outFile = new File(outputPath);
        if (!outFile.exists) {
            return "ERROR_FILE_NOT_CREATED:" + res;
        }

        return "SUCCESS";

    } catch (e) {
        return "ERROR_EXPORT:" + e.toString();
    }
}

function getOrCreateAutoCapsFolder() {
    var root = app.project.rootItem;
    for (var i = 0; i < root.children.numItems; i++) {
        if (root.children[i].name === "AutoCaps") {
            return root.children[i];
        }
    }
    // הפונקציה הנכונה
    return root.createBin("AutoCaps");
}

function importAndPlaceSRT(srtPath, range) {
    try {
        var seq = app.project.activeSequence;
        if (!seq) return "ERROR_NO_SEQUENCE";

        var srtFile = new File(srtPath);
        if (!srtFile.exists) return "ERROR_SRT_NOT_FOUND:" + srtPath;

        var autoCapsFolder = getOrCreateAutoCapsFolder();
        if (!autoCapsFolder) return "ERROR_CANT_CREATE_FOLDER";

        // שמירת כמות הפריטים הנוכחית בתיקייה כדי לזהות את הקובץ החדש
        var beforeImportCount = autoCapsFolder.children.numItems;

        // ייבוא הקובץ ישירות לתיקיית AutoCaps
        var imported = app.project.importFiles([srtFile.fsName], true, autoCapsFolder, false);
        if (!imported || autoCapsFolder.children.numItems <= beforeImportCount) {
            return "ERROR_IMPORT_FAILED";
        }

        // הפריט האחרון שנוסף לתיקייה הוא ה-SRT שייבאנו
        var srtProjectItem = autoCapsFolder.children[autoCapsFolder.children.numItems - 1];

        // --- חישוב מיקום ההתחלה ---
        var startSeconds = 0;

        // אם המשתמש לא בחר לייצא את כל הסיקוונס (כלומר בחר In/Out או Workarea)
        if (range !== "entire") {
            if (typeof seq.getInPoint === "function" || seq.getInPoint !== undefined) {
                try {
                    var inPointSec = parseFloat(seq.getInPoint());
                    if (!isNaN(inPointSec) && inPointSec >= 0) {
                        startSeconds = inPointSec;
                    }
                } catch (eIn) {
                    startSeconds = 0; // ברירת מחדל להתחלה במקרה של שגיאה
                }
            }
        }

        // בדיקה האם פרמייר תומכת ביצירת ערוץ כתוביות נייטיב (גרסאות חדשות)
        if (typeof seq.createCaptionTrack === "function") {
            try {
                var format;
                try { 
                    format = Sequence.CAPTION_FORMAT_SUBTITLE; 
                } catch (eFmt) { 
                    format = undefined; 
                }

                var isCreated = false;
                if (format !== undefined) {
                    isCreated = seq.createCaptionTrack(srtProjectItem, startSeconds, format);
                } else {
                    isCreated = seq.createCaptionTrack(srtProjectItem, startSeconds);
                }

                if (isCreated) {
                    return "SUCCESS";
                }
            } catch (eCaptionTrack) {
                // ניסיון אחרון ליצירת ערוץ כתוביות ללא הגדרת פורמט ספציפי
                try {
                    if (seq.createCaptionTrack(srtProjectItem, startSeconds)) {
                        return "SUCCESS";
                    }
                } catch (eCaptionTrackBackup) {
                    // נמשיך ל-Fallback במידה וזה נכשל
                }
            }
        }

        // --- Fallback לגרסאות ישנות של פרמייר ---
        // ננסה להניח את קובץ הכתוביות על ערוץ הוידאו העליון ביותר במיקום המחושב
        var trackCount = seq.videoTracks.numTracks;
        if (trackCount > 0) {
            try {
                var topTrack = seq.videoTracks[trackCount - 1];
                var insertTime = seq.getPlayerPosition();
                insertTime.seconds = startSeconds; // הגדרת הזמן המדויק להשחלה
                
                topTrack.insertClip(srtProjectItem, insertTime);
                return "SUCCESS";
            } catch (eInsertClip) {
                // אם גם זה נכשל, לפחות ייבאנו את הקובץ בהצלחה לתיקיית הפרויקט
                return "SUCCESS_IMPORTED_ONLY";
            }
        }

        return "SUCCESS_IMPORTED_ONLY";

    } catch (e) {
        return "ERROR_PLACE:" + e.toString();
    }
}


function err(msg) {
    return '{"ok":false, "error":"' + msg + '"}';
}

// עוזרי JSON כלליים - משמשים גם את פונקציות הפודקאסט למטה
function lcEsc(s) {
    return String(s).replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/[\r\n]+/g, " ");
}
function lcErr(msg) {
    return '{"ok":false, "error":"' + lcEsc(String(msg)) + '"}';
}

// ==========================================
// 🎙️ עריכת פודקאסט - ייצוא אודיו מטראק בודד (משתיק את כל שאר טראקי האודיו)
// ==========================================
function lcExportSingleTrackAudio(outPath, eprPath, rangeType, trackIndex) {
    try {
        var seq = app.project.activeSequence;
        if (!seq) return lcErr("no_sequence");
        trackIndex = parseInt(trackIndex, 10);

        var originalStates = [];
        for (var i = 0; i < seq.audioTracks.numTracks; i++) {
            originalStates.push(seq.audioTracks[i].isMuted());
            seq.audioTracks[i].setMute(i === trackIndex ? 0 : 1);
        }

        var out = new File(outPath);
        var epr = new File(eprPath);

        if (!epr.exists) {
            for (var j = 0; j < seq.audioTracks.numTracks; j++) {
                seq.audioTracks[j].setMute(originalStates[j] ? 1 : 0);
            }
            return lcErr("קובץ ה-EPR לא נמצא בנתיב: " + eprPath);
        }

        var rType = parseInt(rangeType, 10) === 1 ? 1 : 0;
        var result = seq.exportAsMediaDirect(out.fsName, epr.fsName, rType);

        // שחזור מצב ההשתקה המקורי של הטראקים תמיד, גם אם הייצוא נכשל
        for (var k = 0; k < seq.audioTracks.numTracks; k++) {
            seq.audioTracks[k].setMute(originalStates[k] ? 1 : 0);
        }

        if (result) {
            return '{"ok":true, "res":"' + lcEsc(String(result)) + '"}';
        }
        return lcErr("export_failed_silently: פרימייר ביטלה את הייצוא באופן פנימי.");
    } catch (e) {
        return lcErr("export_exception: " + e.toString());
    }
}

// ==========================================
// 🎬 עריכת פודקאסט - יישום מפת החיתוכים (תומך בכל כמות טראקי וידאו/דוברים)
// data = { tracks: [videoTrackIndex, ...], cuts: [{start, end, activeVidTrack}, ...] }
// כל טראק וידאו שברשימת tracks ואיננו activeVidTrack בקטע נתון - הקליפ שלו באותו קטע יושבת (disabled)
// ==========================================
function lcApplyPodcastEditsGeneric(dataJson) {
    try {
        var seq = app.project.activeSequence;
        if (!seq) return lcErr("no_sequence");

        var data;
        try { data = eval("(" + dataJson + ")"); }
        catch (e) { return lcErr("json_parse_failed"); }

        if (!data || !data.cuts || !data.tracks) return lcErr("no_data");

        app.enableQE();
        var qeSeq = qe.project.getActiveSequence();
        if (!qeSeq) return lcErr("qe_sequence_not_found");

        var TICKS_PER_SECOND = 254016000000;
        var tpf = 10160640000;
        try {
            if (seq.videoFrameRate && seq.videoFrameRate.ticks) {
                var parsedTpf = parseInt(seq.videoFrameRate.ticks, 10);
                if (parsedTpf > 0) tpf = parsedTpf;
            }
        } catch (e) {}

        function doRazorSafe(sec) {
            if (sec < 0) sec = 0;
            var totalTicks = sec * TICKS_PER_SECOND;
            var totalFrames = Math.round(totalTicks / tpf);
            var timebase = Math.round(TICKS_PER_SECOND / tpf);

            var f = totalFrames % timebase;
            var totalTCSeconds = Math.floor(totalFrames / timebase);
            var s = totalTCSeconds % 60;
            var m = Math.floor(totalTCSeconds / 60) % 60;
            var h = Math.floor(totalTCSeconds / 3600);

            function p(n) { return n < 10 ? "0" + n : "" + n; }
            var tcNDF = p(h) + ":" + p(m) + ":" + p(s) + ":" + p(f);

            var args = [tcNDF, String(Math.round(totalTicks)), String(sec)];
            for (var i = 0; i < args.length; i++) {
                try { if (typeof qeSeq.razor === "function") { qeSeq.razor(args[i]); return; } } catch (e) {}
            }
        }

        var cuts = data.cuts;
        var tracks = data.tracks;

        var cutTimes = [];
        for (var c = 0; c < cuts.length; c++) {
            if (cuts[c].start > 0.01) cutTimes.push(cuts[c].start);
            cutTimes.push(cuts[c].end);
        }
        cutTimes.sort(function (a, b) { return b - a; });

        var uniqueCutTimes = [];
        if (cutTimes.length > 0) {
            uniqueCutTimes.push(cutTimes[0]);
            for (var k = 1; k < cutTimes.length; k++) {
                if (Math.abs(cutTimes[k] - uniqueCutTimes[uniqueCutTimes.length - 1]) > 0.05) {
                    uniqueCutTimes.push(cutTimes[k]);
                }
            }
        }
        for (var u = 0; u < uniqueCutTimes.length; u++) {
            doRazorSafe(uniqueCutTimes[u]);
        }

        function processTrack(trackIndex) {
            var track = seq.videoTracks[trackIndex];
            if (!track || track.isLocked()) return;
            var clips = track.clips;
            if (!clips) return;

            for (var j = clips.numItems - 1; j >= 0; j--) {
                var clip = clips[j];
                if (!clip) continue;

                var clipStart = parseInt(clip.start.ticks, 10) / TICKS_PER_SECOND;
                var clipEnd = parseInt(clip.end.ticks, 10) / TICKS_PER_SECOND;
                var clipMid = (clipStart + clipEnd) / 2.0;

                for (var m2 = 0; m2 < cuts.length; m2++) {
                    var cData = cuts[m2];
                    var margin = 0.05;
                    if (clipMid > (cData.start - margin) && clipMid < (cData.end + margin)) {
                        if (trackIndex !== cData.activeVidTrack) {
                            try { clip.disabled = true; } catch (e) {}
                        }
                        break;
                    }
                }
            }
        }

        for (var t = 0; t < tracks.length; t++) {
            if (tracks[t] !== null && tracks[t] !== undefined && tracks[t] >= 0) {
                processTrack(tracks[t]);
            }
        }

        return '{"ok":true}';
    } catch (e) {
        return lcErr("exception: " + e.toString());
    }
}

// הפונקציה שלך לביצוע ה-Razor ויצירת החיתוכים
function cutSilence(intervalsJson) {
    try {
        var seq = app.project.activeSequence;
        if (!seq) return lcErr("no_sequence");

        var data;
        try { data = eval("(" + intervalsJson + ")"); }
        catch(e) { return lcErr("json_parse_failed"); }

        if (!data) return lcErr("no_data_found");

        var intervals = [];
        if (data instanceof Array) {
            intervals = data;
        } else if (data.intervals && data.intervals instanceof Array) {
            intervals = data.intervals;
        }

        var MIN_SILENCE_DURATION = 0.35; 
        var filteredIntervals = [];
        
        for (var m = 0; m < intervals.length; m++) {
            var inter = intervals[m];
            if (inter.isSilence === undefined || inter.isSilence === true) {
                var duration = inter.end - inter.start;
                if (duration >= MIN_SILENCE_DURATION) {
                    filteredIntervals.push(inter);
                }
            }
        }

        if (filteredIntervals.length === 0) {
            return '{"ok":true, "message":"לא נמצאו קטעי שקט ארוכים מספיק לחיתוך"}';
        }

        app.enableQE();
        var qeSeq = qe.project.getActiveSequence();
        if (!qeSeq) return lcErr("qe_sequence_not_found");

        var TICKS_PER_SECOND = 254016000000;
        var tpf = 10160640000;
        try {
            if (seq.videoFrameRate && seq.videoFrameRate.ticks) {
                var parsedTpf = parseInt(seq.videoFrameRate.ticks, 10);
                if (parsedTpf > 0) tpf = parsedTpf;
            }
        } catch(e) {}

        function doRazorSafe(sec) {
            if (sec < 0) sec = 0;
            var totalTicks = sec * TICKS_PER_SECOND;
            var totalFrames = Math.round(totalTicks / tpf);
            var timebase = Math.round(TICKS_PER_SECOND / tpf);
            
            var f = totalFrames % timebase;
            var totalTCSeconds = Math.floor(totalFrames / timebase);
            var s = totalTCSeconds % 60;
            var m = Math.floor(totalTCSeconds / 60) % 60;
            var h = Math.floor(totalTCSeconds / 3600);
            
            function p(n) { return n < 10 ? "0" + n : "" + n; }
            var tcNDF = p(h) + ":" + p(m) + ":" + p(s) + ":" + p(f);
            
            var args = [ tcNDF, String(Math.round(totalTicks)), String(sec) ];
            for(var i = 0; i < args.length; i++) {
                try { if (typeof qeSeq.razor === "function") { qeSeq.razor(args[i]); return; } } catch(e) {}
            }
        }

        var cutTimes = [];
        for (var j = 0; j < filteredIntervals.length; j++) {
            var inter = filteredIntervals[j];
            if (inter.start > 0.01) cutTimes.push(inter.start);
            cutTimes.push(inter.end);
        }
        
        cutTimes.sort(function(a, b) { return b - a; });
        
        var uniqueCutTimes = [];
        if (cutTimes.length > 0) {
            uniqueCutTimes.push(cutTimes[0]);
            for (var k = 1; k < cutTimes.length; k++) {
                if (Math.abs(cutTimes[k] - uniqueCutTimes[uniqueCutTimes.length - 1]) > 0.04) {
                    uniqueCutTimes.push(cutTimes[k]);
                }
            }
        }

        for (var c = 0; c < uniqueCutTimes.length; c++) {
            doRazorSafe(uniqueCutTimes[c]);
        }

        function cleanTrack(clips) {
            if (!clips) return;
            for (var j = clips.numItems - 1; j >= 0; j--) {
                var clip = clips[j];
                if (!clip) continue;
                
                var clipStart = parseInt(clip.start.ticks, 10) / TICKS_PER_SECOND;
                var clipEnd = parseInt(clip.end.ticks, 10) / TICKS_PER_SECOND;
                var clipDuration = clipEnd - clipStart;
                
                if (clipDuration <= 0) continue;
                
                for (var i = 0; i < filteredIntervals.length; i++) {
                    var r = filteredIntervals[i];
                    var overlapStart = Math.max(clipStart, r.start);
                    var overlapEnd = Math.min(clipEnd, r.end);
                    var overlapDuration = overlapEnd - overlapStart;
                    
                    if (overlapDuration > 0) {
                        if ((overlapDuration / clipDuration) > 0.4 || clipDuration <= 0.12) {
                            try { clip.remove(true, false); } catch(e) {} 
                            break;
                        }
                    }
                }
            }
        }

        for (var v = 0; v < seq.videoTracks.numTracks; v++) {
            if (!seq.videoTracks[v].isLocked()) cleanTrack(seq.videoTracks[v].clips);
        }
        for (var a = 0; a < seq.audioTracks.numTracks; a++) {
            if (!seq.audioTracks[a].isLocked()) cleanTrack(seq.audioTracks[a].clips);
        }

        return '{"ok":true, "message":"החיתוכים בוצעו בהצלחה. כעת לחץ: Sequence > Close Gap"}';
    } catch (err) {
        return lcErr("exception: " + err.toString());
    }
}