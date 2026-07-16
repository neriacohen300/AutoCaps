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