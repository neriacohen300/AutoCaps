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

        // הערה: אין כאן יותר סף מינימלי קשיח (בעבר 0.35 שניות) שהתעלם מהגדרת
        // המשתמש "אורך שקט (ms)". הסינון לפי אורך כבר נעשה ב-FFmpeg לפי מה
        // שהמשתמש הגדיר בממשק; כאן משאירים רק אפסילון זעיר כדי למנוע קטעי
        // שקט באורך אפס/שלילי שנובעים משגיאות עיגול.
        var MIN_SILENCE_DURATION = 0.03;
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
                
                // מרווח סובלנות קטן (בשניות) לספיגת שגיאות עיגול פריימים בהמרה
                // בין שניות ל-ticks (זו שנעשה בה שימוש לביצוע ה-Razor) לבין
                // הקריאה החוזרת של clip.start/clip.end (במרה ההפוכה).
                var EPS = 0.06;

                for (var i = 0; i < filteredIntervals.length; i++) {
                    var r = filteredIntervals[i];

                    // הבדיקה העיקרית: מכיוון שביצענו Razor מדויק בגבולות קטע
                    // השקט, כל קליפ שנוצר מהחיתוך אמור ליפול *כולו* בתוך קטע
                    // השקט או *כולו* מחוצה לו. לכן בודקים אם אמצע הקליפ נמצא
                    // בתוך קטע השקט (± סובלנות) - זו בדיקה יציבה בהרבה מאשר
                    // אחוז חפיפה, שרגיש מדי לעיגולי פריימים על קטעים קצרים.
                    var clipMid = (clipStart + clipEnd) / 2;
                    var midInsideSilence = clipMid >= (r.start - EPS) && clipMid <= (r.end + EPS);

                    // גיבוי: קליפ שכל טווחו כלול כמעט לגמרי בתוך קטע השקט
                    // (למקרה שקטע השקט מכיל כמה קליפים קטנים שלא חולקו בדיוק
                    // באמצעם).
                    var overlapStart = Math.max(clipStart, r.start);
                    var overlapEnd = Math.min(clipEnd, r.end);
                    var overlapDuration = overlapEnd - overlapStart;
                    var mostlyInsideSilence = overlapDuration > 0 && (overlapDuration / clipDuration) > 0.4;

                    if (midInsideSilence || mostlyInsideSilence || clipDuration <= 0.12) {
                        var removed = false;
                        try { clip.remove(true, false); removed = true; } catch(e) {}
                        if (!removed) {
                            try { clip.remove(true); removed = true; } catch(e) {}
                        }
                        if (!removed) {
                            try { clip.remove(); } catch(e) {}
                        }
                        break;
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

// ==========================================
// ✂️ חיתוך שקט - גישת XML (מהיר ואמין יותר מ-Razor+Remove דרך QE)
// במקום לחתוך ולמחוק קליפים בתוך הסיקוונס הקיים (שהתגלה כלא אמין - משאיר
// לפעמים "שאריות" שקט קטנות בגלל אופן פעולת ה-QE API), הגישה כאן בונה
// קובץ XML (Final Cut Pro XML) חדש לגמרי המכיל רק את הקטעים שצריך לשמור,
// ומייבא אותו כסיקוונס חדש. Premiere בעצמו אחראי על בניית הסיקוונס מה-XML,
// כך שאין תלות בהתנהגות לא עקבית של מחיקת קליפים.
//
// הערה חשובה: הגרסה הנוכחית תומכת בתרחיש הנפוץ ביותר - קליפ וידאו רציף
// יחיד על טראק V1 (למשל עריכת "טוקינג-הד"). אם יש כמה קליפים על V1,
// הפונקציה תשתמש רק בקליפ הראשון.
// ==========================================

// שולף מהסיקוונס הפעיל את רשימת כל הקליפים שעל טראק V1 (בכל כמות - לא רק
// קליפ בודד), עם נקודות ה-Start/End שלהם בציר הזמן של הסיקוונס ונקודת ה-IN
// שלהם במדיה המקורית. זה מאפשר למפות כל קטע "לשמירה" (אחרי חיתוך השקט)
// לקובץ המקור הנכון ולזמן הנכון בתוכו, גם כשיש כמה קליפים/קבצים על הטראק.
function getSequenceClipsInfo() {
    try {
        var seq = app.project.activeSequence;
        if (!seq) return lcErr("no_sequence");
        if (seq.videoTracks.numTracks === 0) return lcErr("no_video_tracks");

        var vTrack = seq.videoTracks[0];
        if (!vTrack || vTrack.clips.numItems === 0) return lcErr("no_clips_on_v1");

        var TICKS_PER_SECOND = 254016000000;
        var tpf = 10160640000;
        try {
            if (seq.videoFrameRate && seq.videoFrameRate.ticks) {
                var parsedTpf = parseInt(seq.videoFrameRate.ticks, 10);
                if (parsedTpf > 0) tpf = parsedTpf;
            }
        } catch (eTpf) {}
        var fps = TICKS_PER_SECOND / tpf;

        var width = 1920, height = 1080;
        try {
            if (seq.frameSizeHorizontal) width = parseInt(seq.frameSizeHorizontal, 10);
            if (seq.frameSizeVertical) height = parseInt(seq.frameSizeVertical, 10);
        } catch (eSize) {}

        var clipsArr = [];
        for (var c = 0; c < vTrack.clips.numItems; c++) {
            var clip = vTrack.clips[c];
            if (!clip) continue;

            var projectItem = clip.projectItem;
            if (!projectItem) continue;

            var mediaPath = "";
            try { mediaPath = projectItem.getMediaPath(); } catch (eMp) {}
            if (!mediaPath) continue; // מדלגים על קליפי גרפיקה/צבע ללא קובץ מקור אמיתי

            var seqStart = parseInt(clip.start.ticks, 10) / TICKS_PER_SECOND;
            var seqEnd = parseInt(clip.end.ticks, 10) / TICKS_PER_SECOND;
            var sourceIn = parseInt(clip.inPoint.ticks, 10) / TICKS_PER_SECOND;

            clipsArr.push(
                '{"mediaPath":"' + lcEsc(mediaPath) + '"' +
                ',"name":"' + lcEsc(projectItem.name) + '"' +
                ',"seqStart":' + seqStart +
                ',"seqEnd":' + seqEnd +
                ',"sourceIn":' + sourceIn +
                '}'
            );
        }

        if (clipsArr.length === 0) return lcErr("no_usable_clips_on_v1");

        var json = '{"ok":true' +
            ',"fps":' + fps +
            ',"width":' + width +
            ',"height":' + height +
            ',"clips":[' + clipsArr.join(",") + ']' +
            '}';
        return json;
    } catch (e) {
        return lcErr("exception: " + e.toString());
    }
}

// מייבא קובץ XML (שנבנה ב-main.js) כסיקוונס חדש לתוך הפרויקט, ומפעיל אותו
// כטיימליין הפעיל (כאילו לחצו עליו פעמיים בבין הפרויקטים) - כולל ניסיון
// לפתוח אותו בפועל בפאנל הטיימליין, לא רק לסמן אותו כ"פעיל" ברקע.
function importXmlAsNewSequence(xmlPath) {
    try {
        var xmlFile = new File(xmlPath);
        if (!xmlFile.exists) return lcErr("xml_not_found");

        var autoCapsFolder = getOrCreateAutoCapsFolder();
        if (!autoCapsFolder) return lcErr("cant_create_folder");

        var beforeIds = {};
        var beforeCount = app.project.sequences.numSequences;
        for (var s = 0; s < beforeCount; s++) {
            beforeIds[app.project.sequences[s].sequenceID] = true;
        }

        var imported = app.project.importFiles([xmlFile.fsName], true, autoCapsFolder, false);
        if (!imported) return lcErr("import_failed");

        if (app.project.sequences.numSequences <= beforeCount) {
            return lcErr("sequence_not_registered_after_import");
        }

        // מזהים את הסיקוונס החדש לפי מזהה (sequenceID) שלא היה קיים לפני
        // הייבוא - ולא לפי הנחה ש"החדש הוא תמיד האחרון במערך", שגרמה לזיהוי
        // שגוי כשהיה כבר סיקוונס אחר פתוח בפרויקט.
        var newSeq = null;
        for (var s2 = 0; s2 < app.project.sequences.numSequences; s2++) {
            var candidate = app.project.sequences[s2];
            if (!beforeIds[candidate.sequenceID]) {
                newSeq = candidate;
                break;
            }
        }
        if (!newSeq) return lcErr("cant_identify_new_sequence");

        // ניסיון בפועל לפתוח את הסיקוונס בפאנל הטיימליין (לא רק להגדיר כפעיל
        // ברקע - openSequence הוא זה שבפועל "מקפיץ" אותו על המסך).
        var openedInPanel = false;
        try {
            if (typeof app.project.openSequence === "function") {
                try {
                    openedInPanel = !!app.project.openSequence(newSeq.sequenceID);
                } catch (eOpenA) {
                    try {
                        openedInPanel = !!app.project.openSequence({ sequenceID: newSeq.sequenceID });
                    } catch (eOpenB) {}
                }
            }
        } catch (eOpen) {}

        try { app.project.activeSequence = newSeq; } catch (eActive) {}

        return '{"ok":true, "sequenceName":"' + lcEsc(newSeq.name) + '", "openedInPanel":' + (openedInPanel ? "true" : "false") + '}';
    } catch (e) {
        return lcErr("exception: " + e.toString());
    }
}


function applyAutoZooms(dataJson) {
    try {
        var seq = app.project.activeSequence;
        if (!seq) return '{"ok":false, "error":"אין סיקוונס פעיל"}';

        var data;
        try { 
            data = eval("(" + dataJson + ")"); 
        } catch(e) { 
            return '{"ok":false, "error":"שגיאת פענוח נתונים"}'; 
        }

        // Apply to the first targeted video track. Modify if you want it to target specific tracks.
        var targetTrack = seq.videoTracks[0]; 
        if (!targetTrack || targetTrack.clips.numItems === 0) {
            return '{"ok":false, "error":"לא נמצאו קליפים בערוץ הוידאו הראשון"}';
        }

        var clips = targetTrack.clips;
        var appliedCount = 0;

        for (var i = 0; i < clips.numItems; i++) {
            var clip = clips[i];
            
            // If Alternating frequency is selected, skip every other clip
            if (data.frequency === "alternating" && i % 2 !== 0) continue;
            
            var motionEffect = null;
            // Find the intrinsic "Motion" component
            for (var c = 0; c < clip.components.numItems; c++) {
                if (clip.components[c].matchName === "AE.ADBE Motion") {
                    motionEffect = clip.components[c];
                    break;
                }
            }
            
            if (!motionEffect) continue;

            var scaleProp = motionEffect.properties[1]; // Index 1 is always Scale in Motion
            var startSec = clip.start.seconds;
            var endSec = clip.end.seconds;
            var duration = endSec - startSec;

            if (data.style === "jump") {
                // Style 1: Jump Cut (Hard and instant zoom, no keyframes)
                scaleProp.setTimeVarying(false); 
                scaleProp.setValue(data.intensity, 1);
            } 
            else if (data.style === "smooth") {
                // Style 2: Smooth (Cinematic zoom in and out)
                scaleProp.setTimeVarying(true); // Enables Keyframing
                
                scaleProp.addKey(startSec);
                scaleProp.setValueAtKey(startSec, 100, 1);
                
                var midPoint = startSec + (duration / 2);
                scaleProp.addKey(midPoint);
                scaleProp.setValueAtKey(midPoint, data.intensity, 1);
                
                scaleProp.addKey(endSec);
                scaleProp.setValueAtKey(endSec, 100, 1);
            }
            else if (data.style === "snap") {
                // Style 3: Snap In (Fast progressive zoom, then hold)
                scaleProp.setTimeVarying(true);
                
                scaleProp.addKey(startSec);
                scaleProp.setValueAtKey(startSec, 100, 1);
                
                // Snap in over 0.25 seconds or 20% of the clip duration (whichever is faster)
                var snapTime = startSec + Math.min(0.25, duration * 0.2); 
                scaleProp.addKey(snapTime);
                scaleProp.setValueAtKey(snapTime, data.intensity, 1);
                
                // Hold zoom until the end
                scaleProp.addKey(endSec);
                scaleProp.setValueAtKey(endSec, data.intensity, 1);
            }
            
            appliedCount++;
        }

        return '{"ok":true, "count":' + appliedCount + '}';
    } catch (err) {
        return '{"ok":false, "error":"' + err.toString() + '"}';
    }
}


function applyAutoZoomsOnLongClips(dataJsonStr) {
    try {
        var seq = app.project.activeSequence;
        if (!seq) return '{"ok":false, "error":"אין סיקוונס פעיל"}';

        var data;
        try { 
            data = eval("(" + dataJsonStr + ")"); 
        } catch(e) { 
            return '{"ok":false, "error":"שגיאת פענוח נתונים"}'; 
        }

        // נריץ על הערוץ הראשון (V1). אם תרצה, אפשר לשנות לערוץ בחירה בהמשך.
        var targetTrack = seq.videoTracks[0]; 
        if (!targetTrack || targetTrack.clips.numItems === 0) {
            return '{"ok":false, "error":"לא נמצאו קליפים בערוץ הוידאו V1"}';
        }

        var clips = targetTrack.clips;
        var appliedCount = 0;

        for (var i = 0; i < clips.numItems; i++) {
            var clip = clips[i];
            
            var motionEffect = null;
            // חיפוש אפקט Motion המובנה שכולל את פרמטר ה-Scale
            for (var c = 0; c < clip.components.numItems; c++) {
                if (clip.components[c].matchName === "AE.ADBE Motion") {
                    motionEffect = clip.components[c];
                    break;
                }
            }
            if (!motionEffect) continue;

            // מאפיין מספר 1 באפקט Motion הוא ה-Scale
            var scaleProp = motionEffect.properties[1]; 
            scaleProp.setTimeVarying(true); // הדלקת שעון עצר (Keyframes)

            var startSec = clip.start.seconds;
            var endSec = clip.end.seconds;
            
            var interval = data.interval; // כל כמה שניות לזוז
            var intensity = data.intensity;
            
            var currentTime = startSec;
            var isZoomedIn = false;

            // המערכת "הולכת" בתוך הקליפ צעד-צעד לפי האינטרוול שנבחר
            while (currentTime < endSec - 0.5) {
                var nextTime = currentTime + interval;
                if (nextTime > endSec) nextTime = endSec;

                var currentScaleValue = isZoomedIn ? intensity : 100;
                var nextScaleValue = isZoomedIn ? 100 : intensity;

                if (data.style === "jump") {
                    // קאט חד באמצעות Keyframes צמודים
                    scaleProp.addKey(currentTime);
                    scaleProp.setValueAtKey(currentTime, currentScaleValue, 1);
                    
                    if (nextTime < endSec) {
                        scaleProp.addKey(nextTime - 0.01);
                        scaleProp.setValueAtKey(nextTime - 0.01, currentScaleValue, 1);
                    }
                } 
                else if (data.style === "smooth") {
                    // תנועה חלקה (Breathing zoom) כל האינטרוול
                    scaleProp.addKey(currentTime);
                    scaleProp.setValueAtKey(currentTime, currentScaleValue, 1);
                    
                    scaleProp.addKey(nextTime);
                    scaleProp.setValueAtKey(nextTime, nextScaleValue, 1);
                } 
                else if (data.style === "snap") {
                    // כניסה מהירה (0.3 שניות) ואז השהייה סטטית
                    scaleProp.addKey(currentTime);
                    scaleProp.setValueAtKey(currentTime, currentScaleValue, 1);
                    
                    var snapTime = Math.min(currentTime + 0.3, nextTime);
                    scaleProp.addKey(snapTime);
                    scaleProp.setValueAtKey(snapTime, nextScaleValue, 1);

                    if (nextTime < endSec) {
                        scaleProp.addKey(nextTime - 0.01);
                        scaleProp.setValueAtKey(nextTime - 0.01, nextScaleValue, 1);
                    }
                }

                currentTime = nextTime;
                isZoomedIn = !isZoomedIn;
                appliedCount++;
            }
        }

        return '{"ok":true, "count":' + appliedCount + '}';
    } catch (err) {
        return '{"ok":false, "error":"' + err.toString() + '"}';
    }
}


function applySmartAutoZooms(dataJsonStr) {
    try {
        var seq = app.project.activeSequence;
        if (!seq) return '{"ok":false, "error":"אין סיקוונס פעיל"}';

        var data;
        try { 
            data = eval("(" + dataJsonStr + ")"); 
        } catch(e) { 
            return '{"ok":false, "error":"שגיאת פענוח נתונים"}'; 
        }

        var targetTrack = seq.videoTracks[0]; 
        if (!targetTrack || targetTrack.clips.numItems === 0) {
            return '{"ok":false, "error":"לא נמצאו קליפים בערוץ V1"}';
        }

        var clips = targetTrack.clips;
        var appliedCount = 0;

        if (data.mode === "clips") {
            // מוד 1: זום לסירוגין - עובד מדהים על מלא קליפים קטנים אחרי Jump Cut
            var zoomIn = false; // מתחילים מקליפ רגיל
            for (var i = 0; i < clips.numItems; i++) {
                var clip = clips[i];
                var motionEffect = getMotionEffect(clip);
                if (!motionEffect) continue;
                
                var scaleProp = motionEffect.properties[1];
                scaleProp.setTimeVarying(false); // מבטל Keyframes כדי להחיל זום סטטי ונקי על כל הקליפ
                scaleProp.setValue(zoomIn ? data.intensity : 100, 1);
                
                zoomIn = !zoomIn; // מחליף מצב לקליפ הבא בתור
                appliedCount++;
            }
        } 
        else if (data.mode === "audio") {
            // מוד 2: זיהוי משפטים חכם - זום שעוקב אחרי קול בקליפים ארוכים (ללא חיתוך)
            var silences = data.silences || [];
            
            for (var i = 0; i < clips.numItems; i++) {
                var clip = clips[i];
                var motionEffect = getMotionEffect(clip);
                if (!motionEffect) continue;
                
                var scaleProp = motionEffect.properties[1];
                
                // איפוס והפעלת Keyframes
                scaleProp.setTimeVarying(false);
                scaleProp.setTimeVarying(true);

                var cStart = clip.start.seconds;
                var cEnd = clip.end.seconds;
                
                // בניית מערך של חלקי ה"דיבור" (ההיפך מהשקט ש-FFmpeg מצא)
                var speechSegments = [];
                var currentSpeechStart = cStart;
                
                for (var s = 0; s < silences.length; s++) {
                    var sil = silences[s];
                    if (sil.end <= cStart || sil.start >= cEnd) continue;
                    
                    var silStartClamped = Math.max(sil.start, cStart);
                    var silEndClamped = Math.min(sil.end, cEnd);
                    
                    if (currentSpeechStart < silStartClamped) {
                        speechSegments.push({start: currentSpeechStart, end: silStartClamped});
                    }
                    currentSpeechStart = silEndClamped;
                }
                if (currentSpeechStart < cEnd) {
                    speechSegments.push({start: currentSpeechStart, end: cEnd});
                }
                
                // עוברים על משפטי הדיבור ומייצרים Keyframes של קאט-וירטואלי (Jump Cut) לפי הדיבור
                var zoomIn = false;
                for (var k = 0; k < speechSegments.length; k++) {
                    var seg = speechSegments[k];
                    var val = zoomIn ? data.intensity : 100;
                    
                    // זום שמתחיל ונגמר בבת אחת (Keyframes מרובעים במהותם)
                    scaleProp.addKey(seg.start);
                    scaleProp.setValueAtKey(seg.start, val, 1);
                    
                    // מחזיק את הזום עד סוף המשפט
                    scaleProp.addKey(seg.end - 0.01);
                    scaleProp.setValueAtKey(seg.end - 0.01, val, 1);
                    
                    zoomIn = !zoomIn; // משפט הבא יקבל את הזום ההפוך
                }
                appliedCount++;
            }
        }

        return '{"ok":true, "count":' + appliedCount + '}';
    } catch (err) {
        return '{"ok":false, "error":"' + err.toString() + '"}';
    }
}

// פונקציית עזר למציאת ה-Motion Effect בכל קליפ
function getMotionEffect(clip) {
    for (var c = 0; c < clip.components.numItems; c++) {
        if (clip.components[c].matchName === "AE.ADBE Motion") {
            return clip.components[c];
        }
    }
    return null;
}