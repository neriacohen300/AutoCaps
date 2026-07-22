// ==========================================
// AutoCaps for After Effects — main.jsx
//
// AE has no equivalent of Premiere's Sequence.exportAsMediaDirect(), so audio
// export goes through the Render Queue instead. AE also has no Sequence /
// Track / Clip model — captions are built as a single text layer on the
// active composition, driven by Source Text keyframes ("dynamic captions"),
// which is the standard pattern AE caption tools use instead of one layer
// per line.
// ==========================================

function getActiveComp() {
    var item = app.project.activeItem;
    if (!item || !(item instanceof CompItem)) return null;
    return item;
}

// ------------------------------------------
// 1. Audio export for transcription (Render Queue based)
// ------------------------------------------
function exportAudioForTranscription(outputPath, rangeType, aomTemplateName) {
    try {
        var comp = getActiveComp();
        if (!comp) return "ERROR_NO_COMP";

        var outFile = new File(outputPath);
        if (outFile.exists) { outFile.remove(); }


        var rqItem = app.project.renderQueue.items.add(comp);

        if (rangeType === "inOut") {
            rqItem.timeSpanStart = comp.workAreaStart;
            rqItem.timeSpanDuration = comp.workAreaDuration;
        } else {
            rqItem.timeSpanStart = 0;
            rqItem.timeSpanDuration = comp.duration;
        }

        var om = rqItem.outputModule(1);

        var templateApplied = false;
        try {
            om.applyTemplate(aomTemplateName);
            templateApplied = true;
        } catch (eTemplate) {
            templateApplied = false;
        }

        if (!templateApplied) {
            rqItem.remove();
            return "ERROR_AOM_TEMPLATE_NOT_FOUND:" + aomTemplateName;
        }

        om.file = outFile;

        // RenderQueueItem has no .render() method - rendering is triggered on the
        // whole queue via app.project.renderQueue.render(). To render only our item,
        // temporarily pause every other queued item, render, then restore their state.
        var rq = app.project.renderQueue;
        var pausedStates = [];
        for (var i = 1; i <= rq.items.length; i++) {
            var qi = rq.item(i);
            pausedStates.push({ item: qi, wasQueued: qi.render });
            if (qi !== rqItem) {
                qi.render = false;
            }
        }

        rq.render();

        for (var j = 0; j < pausedStates.length; j++) {
            try { pausedStates[j].item.render = pausedStates[j].wasQueued; } catch (eRestore) {}
        }

        rqItem.remove();

        outFile = new File(outputPath);
        if (!outFile.exists) {
            return "ERROR_FILE_NOT_CREATED";
        }

        return "SUCCESS";

    } catch (e) {
        return "ERROR_EXPORT:" + e.toString();
    }
}

// ------------------------------------------
// 2. SRT parsing helpers
// ------------------------------------------
function srtTimeToSeconds(t) {
    // פורמט: 00:00:01,240
    var m = t.match(/(\d+):(\d+):(\d+)[,.](\d+)/);
    if (!m) return 0;
    var h = parseInt(m[1], 10);
    var min = parseInt(m[2], 10);
    var s = parseInt(m[3], 10);
    var ms = parseInt(m[4], 10);
    return h * 3600 + min * 60 + s + ms / 1000;
}

function parseSRT(content) {
    // מנרמלים שברי שורה ומפצלים לבלוקים לפי שורה ריקה
    content = content.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
    var blocks = content.split(/\n\s*\n/);
    var captions = [];

    for (var i = 0; i < blocks.length; i++) {
        var block = blocks[i];
        if (!block || !block.replace(/\s/g, "")) continue;

        var lines = block.split("\n");
        var lineIdx = 0;

        // שורה ראשונה היא לרוב מספר סידורי - מדלגים עליה אם היא מספר בלבד
        if (/^\d+$/.test(lines[lineIdx].replace(/\s/g, ""))) {
            lineIdx++;
        }
        if (lineIdx >= lines.length) continue;

        var timeLine = lines[lineIdx];
        var timeMatch = timeLine.match(/(\d+:\d+:\d+[,.]\d+)\s*-->\s*(\d+:\d+:\d+[,.]\d+)/);
        if (!timeMatch) continue;
        lineIdx++;

        var textLines = [];
        for (; lineIdx < lines.length; lineIdx++) {
            textLines.push(lines[lineIdx]);
        }
        var text = textLines.join("\n").replace(/^\s+|\s+$/g, "");
        if (!text) continue;

        captions.push({
            start: srtTimeToSeconds(timeMatch[1]),
            end: srtTimeToSeconds(timeMatch[2]),
            text: text
        });
    }

    return captions;
}

// ------------------------------------------
// 3. Dynamic caption text layer (Source Text keyframes)
// ------------------------------------------
function createDynamicCaptionLayer(srtPath, rangeType) {
    try {
        var comp = getActiveComp();
        if (!comp) return "ERROR_NO_COMP";

        var srtFile = new File(srtPath);
        if (!srtFile.exists) return "ERROR_SRT_NOT_FOUND:" + srtPath;

        srtFile.open("r");
        srtFile.encoding = "UTF-8";
        var content = srtFile.read();
        srtFile.close();

        var captions = parseSRT(content);
        if (captions.length === 0) return "ERROR_NO_CAPTIONS_PARSED";

        var offset = 0;
        if (rangeType === "inOut") {
            offset = comp.workAreaStart;
        }



        var textLayer = comp.layers.addText("");
        textLayer.name = "AutoCaps Subtitles";
        textLayer.moveToBeginning();

        var textProp = textLayer.property("Source Text");
        var baseDoc = textProp.value;
        baseDoc.fontSize = 60;
        baseDoc.justification = ParagraphJustification.CENTER_JUSTIFY;
        baseDoc.applyFill = true;
        baseDoc.fillColor = [1, 1, 1];
        baseDoc.applyStroke = true;
        baseDoc.strokeColor = [0, 0, 0];
        baseDoc.strokeWidth = 3;
        textProp.setValue(baseDoc);

        textLayer.property("Transform").property("Position").setValue([comp.width / 2, comp.height * 0.88]);

        var firstStart = captions[0].start + offset;
        var lastEnd = captions[captions.length - 1].end + offset;
        textLayer.startTime = 0;
        textLayer.inPoint = Math.max(0, firstStart - 0.05);
        textLayer.outPoint = Math.min(comp.duration, lastEnd + 0.05);

        // Build every keyframe's time+text up front, then write them ALL in one
        // batch call. This is what actually caused the crash/slowness before -
        // hundreds of individual setValueAtTime calls each create their own undo
        // step. setValuesAtTimes does it as one operation.
        var EPS = 1 / (comp.frameRate * 2);
        var times = [];
        var texts = [];

        function styledDoc(text) {
            var doc = textProp.value; // fresh, layer-associated TextDocument every call
            doc.text = text;
            doc.fontSize = baseDoc.fontSize;
            doc.justification = baseDoc.justification;
            doc.applyFill = baseDoc.applyFill;
            doc.fillColor = baseDoc.fillColor;
            doc.applyStroke = baseDoc.applyStroke;
            doc.strokeColor = baseDoc.strokeColor;
            doc.strokeWidth = baseDoc.strokeWidth;
            return doc;
        }

        if (firstStart > EPS) {
            times.push(0);
            texts.push(styledDoc(""));
        }

        for (var i = 0; i < captions.length; i++) {
            var cap = captions[i];
            var startSec = Math.max(0, cap.start + offset);
            var endSec = cap.end + offset;

            times.push(startSec);
            texts.push(styledDoc(cap.text));

            var next = captions[i + 1];
            if (next) {
                var nextStart = next.start + offset;
                if (nextStart - endSec > EPS) {
                    times.push(endSec);
                    texts.push(styledDoc(""));
                }
            }
        }

        textProp.setValuesAtTimes(times, texts);

        return '{"ok":true,"count":' + captions.length + '}';

    } catch (e) {
        return '{"ok":false,"error":"' + String(e).replace(/"/g, '\\"') + '"}';
    }
}

