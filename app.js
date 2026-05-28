(function () {
  "use strict";

  const fileInput = document.getElementById("fileInput");
  const chooseBtn = document.getElementById("chooseBtn");
  const dropZone = document.getElementById("dropZone");
  const dropTitle = document.getElementById("dropTitle");
  const thumbStrip = document.getElementById("thumbStrip");
  const formatSelect = document.getElementById("formatSelect");
  const resultsList = document.getElementById("resultsList");
  const summary = document.getElementById("summary");
  const actionHint = document.getElementById("actionHint");
  const afterActions = document.getElementById("afterActions");
  const shareFallback = document.getElementById("shareFallback");
  const shareBtn = document.getElementById("shareBtn");
  const clearBtn = document.getElementById("clearBtn");
  const downloadAllBtn = document.getElementById("downloadAllBtn");
  const detailsPanel = document.getElementById("detailsPanel");
  const yearEl = document.getElementById("year");

  const jobs = [];
  let isProcessing = false;
  let outputFormat = "jpg";

  const formatMeta = {
    jpg: { label: "JPG", mime: "image/jpeg", ext: "jpg" },
    png: { label: "PNG", mime: "image/png", ext: "png" },
    webp: { label: "WebP", mime: "image/webp", ext: "webp" },
    pdf: { label: "PDF", mime: "application/pdf", ext: "pdf" },
  };

  yearEl.textContent = String(new Date().getFullYear());
  initOutputFormat();

  chooseBtn.addEventListener("click", (event) => {
    event.stopPropagation();
    fileInput.click();
  });
  fileInput.addEventListener("change", (event) => {
    if (event.target.files && event.target.files.length > 0) {
      queueFiles(event.target.files);
      fileInput.value = "";
    }
  });

  dropZone.addEventListener("click", () => fileInput.click());
  dropZone.addEventListener("keydown", (event) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      fileInput.click();
    }
  });

  dropZone.addEventListener("dragover", (event) => {
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
    dropZone.classList.add("drag-over");
    dropTitle.textContent = "Drop photos now";
  });

  dropZone.addEventListener("dragleave", () => {
    dropZone.classList.remove("drag-over");
    dropTitle.textContent = "Tap or drag photos here";
  });

  dropZone.addEventListener("drop", (event) => {
    event.preventDefault();
    dropZone.classList.remove("drag-over");
    dropTitle.textContent = "Tap or drag photos here";
    if (event.dataTransfer && event.dataTransfer.files.length > 0) {
      queueFiles(event.dataTransfer.files);
    }
  });

  clearBtn.addEventListener("click", clearAll);
  downloadAllBtn.addEventListener("click", handleSaveAction);
  shareBtn.addEventListener("click", shareFixedPhotos);
  formatSelect.addEventListener("change", () => {
    outputFormat = sanitizeFormat(formatSelect.value);
    window.localStorage.setItem("ipf-output-format", outputFormat);
    formatSelect.value = outputFormat;
    render();
  });

  function queueFiles(fileList) {
    const imageFiles = Array.from(fileList).filter((file) =>
      file.type.startsWith("image/") || hasHeicLikeExtension(file.name)
    );

    if (imageFiles.length === 0) {
      summary.textContent = "No photos found. Try picking images from your phone album.";
      return;
    }

    imageFiles.forEach((file) => {
      jobs.push({
        id: crypto.randomUUID(),
        file,
        format: outputFormat,
        sourcePreviewUrl: shouldCreateSourcePreview(file) ? URL.createObjectURL(file) : "",
        outputBlob: null,
        outputName: null,
        outputUrl: null,
        status: "queued",
        errorMessage: "",
      });
    });

    render();
    processQueue();
  }

  async function processQueue() {
    if (isProcessing) {
      return;
    }

    isProcessing = true;

    for (const job of jobs) {
      if (job.status !== "queued") {
        continue;
      }

      job.status = "processing";
      render();

      try {
        const outputBlob = await convertToJpeg(job.file, job.format);
        const outputName = createOutputName(job.file.name, job.format);
        job.outputBlob = outputBlob;
        job.outputName = outputName;
        job.outputUrl = URL.createObjectURL(outputBlob);
        job.status = "done";
      } catch (error) {
        job.status = "error";
        job.errorMessage = getErrorMessage(error);
      }

      render();
    }

    isProcessing = false;
    render();
  }

  async function convertToJpeg(file, format) {
    if (format === "pdf") {
      return convertToPdf(file);
    }
    if (format === "jpg") {
      return convertToRaster(file, "image/jpeg", 0.92);
    }
    if (format === "png") {
      return convertToRaster(file, "image/png");
    }
    if (format === "webp") {
      return convertToRaster(file, "image/webp", 0.9);
    }
    return convertToRaster(file, "image/jpeg", 0.92);
  }

  async function convertToRaster(file, mimeType, quality) {
    const normalizedInput = await getRenderableInput(file);
    if (normalizedInput.type === mimeType && mimeType !== "image/webp") {
      return normalizedInput;
    }

    const canvas = await drawFileToCanvas(normalizedInput);
    const blob = await canvasToBlob(canvas, mimeType, quality);
    if (!blob) {
      throw new Error("Could not convert this photo.");
    }
    return blob;
  }

  async function convertToPdf(file) {
    const normalizedInput = await getRenderableInput(file);
    const canvas = await drawFileToCanvas(normalizedInput);
    const imageData = canvas.toDataURL("image/jpeg", 0.95);
    const { jsPDF } = window.jspdf || {};
    if (typeof jsPDF !== "function") {
      throw new Error("PDF converter failed to load.");
    }

    const doc = new jsPDF({
      orientation: canvas.width >= canvas.height ? "landscape" : "portrait",
      unit: "px",
      format: [canvas.width, canvas.height],
    });
    doc.addImage(imageData, "JPEG", 0, 0, canvas.width, canvas.height);
    return doc.output("blob");
  }

  async function getRenderableInput(file) {
    if (isHeic(file)) {
      return convertHeicBlob(file);
    }
    return file;
  }

  async function convertHeicBlob(file) {
    if (typeof window.heic2any !== "function") {
      throw new Error("HEIC converter library failed to load.");
    }
    const converted = await window.heic2any({
      blob: file,
      toType: "image/jpeg",
      quality: 0.92,
    });
    const blob = Array.isArray(converted) ? converted[0] : converted;
    if (!(blob instanceof Blob)) {
      throw new Error("Unable to convert that HEIC file.");
    }
    return blob;
  }

  async function drawFileToCanvas(file) {
    const bitmap = await createImageBitmap(file);
    const canvas = document.createElement("canvas");
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const ctx = canvas.getContext("2d");
    if (!ctx) {
      bitmap.close();
      throw new Error("Could not process this image.");
    }
    ctx.drawImage(bitmap, 0, 0);
    bitmap.close();
    return canvas;
  }

  async function canvasToBlob(canvas, mimeType, quality) {
    return new Promise((resolve) => canvas.toBlob(resolve, mimeType, quality));
  }

  function isHeic(file) {
    const type = file.type.toLowerCase();
    if (type.includes("heic") || type.includes("heif")) {
      return true;
    }
    return hasHeicLikeExtension(file.name);
  }

  function hasHeicLikeExtension(filename) {
    return /\.(heic|heif)$/i.test(filename);
  }

  function createOutputName(inputName, format) {
    const withoutExt = inputName.replace(/\.[^.]+$/, "");
    const ext = formatMeta[format] ? formatMeta[format].ext : "jpg";
    return `${withoutExt || "converted-photo"}.${ext}`;
  }

  async function downloadAllAsZip() {
    const complete = jobs.filter((job) => job.status === "done" && job.outputBlob);
    if (complete.length === 0) {
      return;
    }

    if (complete.length === 1) {
      triggerDownload(complete[0].outputBlob, complete[0].outputName);
      return;
    }

    if (typeof window.JSZip !== "function") {
      summary.textContent =
        "Could not create ZIP right now. You can still download each photo.";
      return;
    }

    downloadAllBtn.disabled = true;
    downloadAllBtn.textContent = "Preparing download...";

    try {
      const zip = new window.JSZip();
      complete.forEach((job) => {
        zip.file(job.outputName, job.outputBlob);
      });

      const zipBlob = await zip.generateAsync({ type: "blob" });
      triggerDownload(zipBlob, `iphone-photo-fix-${dateStamp()}.zip`);
    } catch (error) {
      summary.textContent =
        "Could not create ZIP for this batch. Try downloading one by one.";
    } finally {
      downloadAllBtn.disabled = false;
      downloadAllBtn.textContent = "Save All";
    }
  }

  async function handleSaveAction() {
    const complete = jobs.filter((job) => job.status === "done" && job.outputBlob);
    if (complete.length === 0) {
      return;
    }

    if (complete.length === 1) {
      await saveSingleJob(complete[0]);
      return;
    }

    await downloadAllAsZip();
  }

  async function shareFixedPhotos() {
    const complete = jobs.filter((job) => job.status === "done" && job.outputBlob);
    if (complete.length === 0) {
      return;
    }

    if (complete.length === 1) {
      await shareSingleJob(complete[0]);
      return;
    }

    const files = complete.map((job) => buildShareFile(job));

    if (canUseNativeFileShare(files)) {
      try {
        await navigator.share({
          files,
          title: "Fixed JPG Photos",
          text: "Ready to send",
        });
        return;
      } catch (error) {
        if (String(error && error.name) === "AbortError") {
          return;
        }
      }
    }

    if (complete.length === 1) {
      triggerDownload(complete[0].outputBlob, complete[0].outputName);
      return;
    }

    await downloadAllAsZip();
  }

  async function shareSingleJob(job) {
    const file = buildShareFile(job);
    if (canUseNativeFileShare([file])) {
      try {
        await navigator.share({
          files: [file],
          title: job.outputName || "Fixed photo",
          text: "Ready to send",
        });
        return;
      } catch (error) {
        if (String(error && error.name) === "AbortError") {
          return;
        }
      }
    }
    triggerDownload(job.outputBlob, job.outputName);
  }

  async function saveSingleJob(job) {
    const file = buildShareFile(job);

    if (canUsePhotoSaveFlow(job) && canUseNativeFileShare([file])) {
      try {
        await navigator.share({
          files: [file],
          title: job.outputName || "Fixed photo",
          text: "Tap Save Image to add it to Photos.",
        });
        return;
      } catch (error) {
        if (String(error && error.name) === "AbortError") {
          return;
        }
      }
    }

    triggerDownload(job.outputBlob, job.outputName);
  }

  function buildShareFile(job) {
    return new File([job.outputBlob], job.outputName || "converted-photo.jpg", {
      type: getMimeFromName(job.outputName),
    });
  }

  function canUseNativeFileShare(files) {
    if (typeof navigator.share !== "function" || typeof navigator.canShare !== "function") {
      return false;
    }
    try {
      return navigator.canShare({ files });
    } catch (error) {
      return false;
    }
  }

  function hasNativeFileShareCapability() {
    return typeof navigator.share === "function" && typeof navigator.canShare === "function";
  }

  function canUsePhotoSaveFlow(job) {
    if (!job || !job.outputName || !job.outputBlob) {
      return false;
    }
    if (!isAppleMobileDevice()) {
      return false;
    }
    return getMimeFromName(job.outputName).startsWith("image/");
  }

  function isAppleMobileDevice() {
    const ua = navigator.userAgent || "";
    const platform = navigator.platform || "";
    const touchPoints = Number(navigator.maxTouchPoints || 0);
    const iosDevice = /iPhone|iPad|iPod/i.test(ua);
    const ipadDesktopUa = platform === "MacIntel" && touchPoints > 1;
    return iosDevice || ipadDesktopUa;
  }

  function getMimeFromName(filename) {
    if (/\.png$/i.test(filename || "")) {
      return "image/png";
    }
    if (/\.webp$/i.test(filename || "")) {
      return "image/webp";
    }
    if (/\.pdf$/i.test(filename || "")) {
      return "application/pdf";
    }
    return "image/jpeg";
  }

  function sanitizeFormat(value) {
    return formatMeta[value] ? value : "jpg";
  }

  function initOutputFormat() {
    const saved = window.localStorage.getItem("ipf-output-format");
    outputFormat = sanitizeFormat(saved || formatSelect.value || "jpg");
    formatSelect.value = outputFormat;
  }

  function clearAll() {
    jobs.forEach((job) => {
      if (job.sourcePreviewUrl) {
        URL.revokeObjectURL(job.sourcePreviewUrl);
      }
      if (job.outputUrl) {
        URL.revokeObjectURL(job.outputUrl);
      }
    });
    jobs.length = 0;
    render();
  }

  function triggerDownload(blob, filename) {
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = filename;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    URL.revokeObjectURL(url);
  }

  function dateStamp() {
    const now = new Date();
    return `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, "0")}${String(
      now.getDate()
    ).padStart(2, "0")}`;
  }

  function getErrorMessage(error) {
    if (!error) {
      return "Conversion failed.";
    }
    const message = String(error.message || error);
    if (message.toLowerCase().includes("library")) {
      return "Converter failed to load. Refresh and try again.";
    }
    if (message.toLowerCase().includes("decode")) {
      return "Could not read that file. Try another photo.";
    }
    return "Could not convert this photo.";
  }

  function formatBytes(bytes) {
    if (!Number.isFinite(bytes) || bytes <= 0) {
      return "0 B";
    }
    const units = ["B", "KB", "MB", "GB"];
    const unitIndex = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
    const value = bytes / Math.pow(1024, unitIndex);
    return `${value.toFixed(value >= 10 || unitIndex === 0 ? 0 : 1)} ${units[unitIndex]}`;
  }

  function render() {
    resultsList.innerHTML = "";
    thumbStrip.innerHTML = "";

    jobs.forEach((job) => {
      const li = document.createElement("li");
      li.className = "result-item";

      const left = document.createElement("div");
      const nameLine = document.createElement("p");
      nameLine.className = "name-line";
      nameLine.textContent = job.outputName || job.file.name;

      const metaLine = document.createElement("p");
      metaLine.className = "meta-line";
      metaLine.textContent = formatBytes(job.file.size);

      const statusLine = document.createElement("p");
      statusLine.className = "status-line";

      if (job.status === "queued") {
        statusLine.classList.add("status-processing");
        statusLine.textContent = "Waiting...";
      } else if (job.status === "processing") {
        statusLine.classList.add("status-processing");
        statusLine.textContent = "Fixing...";
      } else if (job.status === "done") {
        statusLine.classList.add("status-done");
        statusLine.textContent = "Fixed";
      } else if (job.status === "error") {
        statusLine.classList.add("status-error");
        statusLine.textContent = job.errorMessage || "Could not convert this photo.";
      }

      left.append(nameLine, metaLine, statusLine);

      const actionGroup = document.createElement("div");
      actionGroup.className = "item-actions";

      const shareItemBtn = document.createElement("button");
      shareItemBtn.className = "share-btn";
      shareItemBtn.type = "button";
      shareItemBtn.textContent = "Share";
      shareItemBtn.disabled = job.status !== "done";
      shareItemBtn.addEventListener("click", async () => {
        if (job.status === "done") {
          await shareSingleJob(job);
        }
      });

      const downloadBtn = document.createElement("button");
      downloadBtn.className = "download-btn";
      downloadBtn.type = "button";
      downloadBtn.textContent = canUsePhotoSaveFlow(job) ? "Save to Photos" : "Save";
      downloadBtn.disabled = job.status !== "done";
      downloadBtn.addEventListener("click", async () => {
        if (job.outputBlob && job.outputName) {
          await saveSingleJob(job);
        }
      });

      actionGroup.append(shareItemBtn, downloadBtn);
      li.append(left, actionGroup);
      resultsList.append(li);
    });

    const doneCount = jobs.filter((job) => job.status === "done").length;
    const errorCount = jobs.filter((job) => job.status === "error").length;
    const processingCount = jobs.filter((job) => job.status === "processing").length;
    const queuedCount = jobs.filter((job) => job.status === "queued").length;

    const canShare = hasNativeFileShareCapability();
    const firstDoneJob = jobs.find((job) => job.status === "done" && job.outputBlob);
    const showSaveToPhotos = doneCount === 1 && canUsePhotoSaveFlow(firstDoneJob);
    shareBtn.textContent = "Share";
    downloadAllBtn.textContent =
      doneCount <= 1 ? (showSaveToPhotos ? "Save to Photos" : "Save") : "Save All";

    if (jobs.length === 0) {
      summary.textContent = "Step 1: Pick your photos to get started.";
      actionHint.classList.add("is-hidden");
      actionHint.textContent = "";
      clearBtn.classList.add("is-hidden");
    } else if (processingCount > 0 || queuedCount > 0) {
      summary.textContent = `Working on your photos... ${doneCount} ready${
        errorCount > 0 ? `, ${errorCount} skipped` : ""
      }.`;
      actionHint.classList.add("is-hidden");
      actionHint.textContent = "";
      clearBtn.classList.remove("is-hidden");
    } else {
      summary.textContent =
        doneCount > 0
          ? `${doneCount} file${doneCount === 1 ? "" : "s"} fixed.`
          : "We could not fix these photos. Try another image.";

      if (doneCount > 0) {
        actionHint.textContent = canShare
          ? showSaveToPhotos
            ? "Next: tap Save to Photos or Share above."
            : "Next: tap Share or Save above."
          : "Next: tap Save above.";
        actionHint.classList.remove("is-hidden");
      } else {
        actionHint.classList.add("is-hidden");
        actionHint.textContent = "";
      }
      clearBtn.classList.remove("is-hidden");
    }

    afterActions.classList.toggle("is-hidden", jobs.length === 0);
    afterActions.classList.toggle("sticky-actions", doneCount > 0 && !isProcessing);
    detailsPanel.classList.toggle("is-hidden", jobs.length === 0);
    dropZone.classList.toggle("drop-zone-attention", jobs.length === 0);
    thumbStrip.classList.toggle("is-hidden", jobs.length === 0);

    const showShareFallback = doneCount > 0 && !canShare;
    shareFallback.classList.toggle("is-hidden", !showShareFallback);
    shareFallback.textContent = showShareFallback
      ? "Share is not supported here. Tap Save, then send from Photos or Files."
      : "";

    if (jobs.length > 0) {
      const stripTitle = document.createElement("p");
      stripTitle.className = "thumb-strip-title";
      stripTitle.textContent = `${jobs.length} photo${jobs.length === 1 ? "" : "s"} added`;
      thumbStrip.append(stripTitle);

      const grid = document.createElement("div");
      grid.className = "thumb-grid";

      jobs.slice(0, 6).forEach((job) => {
        const card = document.createElement("div");
        card.className = "thumb-card";

        const media = document.createElement("div");
        media.className = "thumb-media";

        if (job.status === "done" && isImageFileName(job.outputName)) {
          const img = document.createElement("img");
          img.src = job.outputUrl;
          img.alt = job.outputName || "Converted photo";
          img.loading = "lazy";
          media.append(img);
        } else if (job.sourcePreviewUrl) {
          const img = document.createElement("img");
          img.src = job.sourcePreviewUrl;
          img.alt = job.file.name || "Selected photo";
          img.loading = "lazy";
          media.append(img);
        } else {
          const placeholder = document.createElement("span");
          placeholder.className = "thumb-placeholder";
          placeholder.textContent = "Photo";
          media.append(placeholder);
        }

        const label = document.createElement("p");
        label.className = "thumb-label";
        label.textContent = truncateName(job.file.name, 16);

        card.append(media, label);
        grid.append(card);
      });

      if (jobs.length > 6) {
        const more = document.createElement("div");
        more.className = "thumb-more";
        more.textContent = `+${jobs.length - 6}`;
        grid.append(more);
      }

      thumbStrip.append(grid);
    }

    shareBtn.disabled = doneCount === 0 || isProcessing || !canShare;
    clearBtn.disabled = jobs.length === 0 || isProcessing;
    downloadAllBtn.disabled = doneCount === 0 || isProcessing;
  }

  function shouldCreateSourcePreview(file) {
    if (!file || !file.type) {
      return false;
    }
    if (isHeic(file)) {
      return false;
    }
    return file.type.startsWith("image/");
  }

  function isImageFileName(filename) {
    return /\.(jpg|jpeg|png|webp)$/i.test(filename || "");
  }

  function truncateName(name, maxChars) {
    if (!name || name.length <= maxChars) {
      return name || "photo";
    }
    return `${name.slice(0, Math.max(0, maxChars - 1))}…`;
  }
})();
