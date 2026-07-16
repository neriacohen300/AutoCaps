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

function importAndPlaceSRT(srtPath) {
    try {
        var seq = app.project.activeSequence;
        if (!seq) return "ERROR_NO_SEQUENCE";

        var srtFile = new File(srtPath);
        if (!srtFile.exists) return "ERROR_SRT_NOT_FOUND:" + srtPath;

        var autoCapsFolder = getOrCreateAutoCapsFolder();
        if (!autoCapsFolder) return "ERROR_CANT_CREATE_FOLDER";

        // שמירת כמות הפריטים הנוכחית בתיקייה
        var beforeImportCount = autoCapsFolder.children.numItems;

        // ייבוא הקובץ ישירות לתיקיית AutoCaps
        var imported = app.project.importFiles([srtFile.fsName], true, autoCapsFolder, false);
        if (!imported || autoCapsFolder.children.numItems <= beforeImportCount) {
            return "ERROR_IMPORT_FAILED";
        }

        // הפריט האחרון שנוסף לתיקייה הוא ה-SRT שייבאנו
        var srtProjectItem = autoCapsFolder.children[autoCapsFolder.children.numItems - 1];

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
                    isCreated = seq.createCaptionTrack(srtProjectItem, 0, format);
                } else {
                    isCreated = seq.createCaptionTrack(srtProjectItem, 0);
                }

                if (isCreated) {
                    return "SUCCESS";
                }
            } catch (eCaptionTrack) {
                // ניסיון אחרון ליצירת ערוץ כתוביות ללא הגדרת פורמט ספציפי
                try {
                    if (seq.createCaptionTrack(srtProjectItem, 0)) {
                        return "SUCCESS";
                    }
                } catch (eCaptionTrackBackup) {
                    // נמשיך ל-Fallback במידה וזה נכשל
                }
            }
        }

        // --- Fallback לגרסאות ישנות של פרמייר ---
        // ננסה להניח את קובץ הכתוביות על ערוץ הוידאו העליון ביותר
        var trackCount = seq.videoTracks.numTracks;
        if (trackCount > 0) {
            try {
                var topTrack = seq.videoTracks[trackCount - 1];
                var timeZero = seq.getPlayerPosition();
                timeZero.seconds = 0;
                
                topTrack.insertClip(srtProjectItem, timeZero);
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