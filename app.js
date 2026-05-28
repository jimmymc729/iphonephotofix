(function () {
  "use strict";

  const fileInput = document.getElementById("fileInput");
  const chooseBtn = document.getElementById("chooseBtn");
  const dropZone = document.getElementById("dropZone");
  const dropTitle = document.getElementById("dropTitle");
  const thumbStrip = document.getElementById("thumbStrip");
  const progressWrap = document.getElementById("progressWrap");
  const progressLabel = document.getElementById("progressLabel");
  const progressPercent = document.getElementById("progressPercent");
  const progressFill = document.getElementById("progressFill");
  const progressEta = document.getElementById("progressEta");
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

  const MAX_FILES_PER_BATCH = 60;
  const SLOW_BATCH_HINT_THRESHOLD = 20;
  const NATIVE_SHARE_BATCH_LIMIT = 10;

  const jobs = [];
  let isProcessing = false;
  let outputFormat = "jpg";
  let activeBatchId = "";
  let activeBatchStartedAt = 0;
  let shareNotice = "";

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
  downloadAllBtn.addEventListener("click", downloadAllAsZip);
  shareBtn.addEventListener("click", shareFixedPhotos);
  formatSelect.addEventListener("change", () => {
    outputFormat = sanitizeFormat(formatSelect.value);
    window.localStorage.setItem("ipf-output-format", outputFormat);
    formatSelect.value = outputFormat;
    render();
  });

  function queueFiles(fileList) {
    shareNotice = "";
    const selectedFiles = Array.from(fileList);
    const imageFiles = selectedFiles.filter((file) =>
      file.type.startsWith("image/") || hasHeicLikeExtension(file.name)
    );

    if (imageFiles.length === 0) {
      summary.textContent = "No photos found. Try picking images from your phone album.";
      trackEvent("photos_selected_invalid", { attempted_count: selectedFiles.length || 0 });
      return;
    }

    let filesToQueue = imageFiles;
    if (imageFiles.length > MAX_FILES_PER_BATCH) {
      filesToQueue = imageFiles.slice(0, MAX_FILES_PER_BATCH);
      summary.textContent = `Added first ${MAX_FILES_PER_BATCH} photos. For best speed, do large batches in smaller groups.`;
      trackEvent("photos_batch_limited", {
        selected_count: imageFiles.length,
        accepted_count: filesToQueue.length,
      });
    }

    const hasPendingJobs = jobs.some((job) => job.status === "queued" || job.status === "processing");
    if (!hasPendingJobs) {
      activeBatchId = crypto.randomUUID();
      activeBatchStartedAt = Date.now();
    }

    const heicCount = filesToQueue.filter((file) => isHeic(file)).length;
    trackEvent("photos_selected", {
      file_count: filesToQueue.length,
      heic_count: heicCount,
      output_format: outputFormat,
    });

    filesToQueue.forEach((file) => {
      jobs.push({
        id: crypto.randomUUID(),
        batchId: activeBatchId,
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

    if (!activeBatchStartedAt) {
      activeBatchStartedAt = Date.now();
    }

    isProcessing = true;

    for (const job of jobs) {
      if (job.status !== "queued") {
        continue;
      }

      job.status = "processing";
      trackEvent("conversion_started", {
        output_format: job.format,
        source_type: isHeic(job.file) ? "heic" : "other_image",
      });
      render();

      try {
        const outputBlob = await convertToJpeg(job.file, job.format);
        const outputName = createOutputName(job.file.name, job.format);
        job.outputBlob = outputBlob;
        job.outputName = outputName;
        job.outputUrl = URL.createObjectURL(outputBlob);
        job.status = "done";
        trackEvent("conversion_success", {
          output_format: job.format,
          source_type: isHeic(job.file) ? "heic" : "other_image",
        });
      } catch (error) {
        job.status = "error";
        job.errorMessage = getErrorMessage(error);
        trackEvent("conversion_error", {
          output_format: job.format,
          error_type: classifyConversionError(error),
        });
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

  async function downloadAllAsZip(source = "download_button") {
    const complete = jobs.filter((job) => job.status === "done" && job.outputBlob);
    if (complete.length === 0) {
      return;
    }

    if (complete.length === 1) {
      trackEvent("download_clicked", {
        file_count: 1,
        output_format: complete[0].format,
        download_type: "single_file",
        source,
      });
      triggerDownload(complete[0].outputBlob, complete[0].outputName);
      return;
    }

    trackEvent("download_clicked", {
      file_count: complete.length,
      output_format: "mixed_or_batch",
      download_type: "zip",
      source,
    });

    if (typeof window.JSZip !== "function") {
      summary.textContent =
        "Could not create ZIP right now. You can still download each photo.";
      trackEvent("download_error", {
        download_type: "zip",
        reason: "zip_library_missing",
      });
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
      trackEvent("download_success", {
        file_count: complete.length,
        output_format: "mixed_or_batch",
        download_type: "zip",
      });
    } catch (error) {
      summary.textContent =
        "Could not create ZIP for this batch. Try downloading one by one.";
      trackEvent("download_error", {
        download_type: "zip",
        reason: "zip_generation_failed",
      });
    } finally {
      downloadAllBtn.disabled = false;
      downloadAllBtn.textContent = "Download ZIP";
    }
  }

  async function shareFixedPhotos() {
    const complete = jobs.filter((job) => job.status === "done" && job.outputBlob);
    if (complete.length === 0) {
      return;
    }

    trackEvent("share_clicked", {
      file_count: complete.length,
      output_format: complete.length === 1 ? complete[0].format : "mixed_or_batch",
      source: "primary_action",
    });

    if (complete.length === 1) {
      shareNotice = "";
      await shareSingleJob(complete[0]);
      render();
      return;
    }

    const files = complete.map((job) => buildShareFile(job));

    if (complete.length > NATIVE_SHARE_BATCH_LIMIT) {
      shareNotice = `Large batch: downloaded ZIP (${complete.length} files). Use per-file "Share or Save" if you want the share menu.`;
      trackEvent("share_fallback_download", {
        file_count: complete.length,
        output_format: "mixed_or_batch",
        reason: "batch_too_large",
      });
      await downloadAllAsZip("share_fallback");
      render();
      return;
    }

    if (canUseNativeFileShare(files)) {
      try {
        await navigator.share({
          files,
          title: "Fixed JPG Photos",
          text: "Ready to send",
        });
        shareNotice = "";
        trackEvent("share_success", {
          file_count: complete.length,
          output_format: "mixed_or_batch",
          method: "native_share",
        });
        render();
        return;
      } catch (error) {
        if (String(error && error.name) === "AbortError") {
          shareNotice = "";
          trackEvent("share_cancelled", {
            file_count: complete.length,
            output_format: "mixed_or_batch",
            method: "native_share",
          });
          render();
          return;
        }
        shareNotice = "Could not open the share sheet, so we downloaded a ZIP instead.";
        trackEvent("share_error", {
          file_count: complete.length,
          output_format: "mixed_or_batch",
          method: "native_share",
        });
      }
    }

    if (complete.length === 1) {
      trackEvent("share_fallback_download", {
        file_count: 1,
        output_format: complete[0].format,
      });
      triggerDownload(complete[0].outputBlob, complete[0].outputName);
      return;
    }

    trackEvent("share_fallback_download", {
      file_count: complete.length,
      output_format: "mixed_or_batch",
    });
    if (!shareNotice) {
      shareNotice = "This browser cannot share this batch directly, so we downloaded a ZIP.";
    }
    await downloadAllAsZip("share_fallback");
    render();
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
        shareNotice = "";
        trackEvent("share_success", {
          file_count: 1,
          output_format: job.format,
          method: "native_share",
        });
        render();
        return;
      } catch (error) {
        if (String(error && error.name) === "AbortError") {
          shareNotice = "";
          trackEvent("share_cancelled", {
            file_count: 1,
            output_format: job.format,
            method: "native_share",
          });
          render();
          return;
        }
        shareNotice = "Could not open share options. Downloaded file instead.";
        trackEvent("share_error", {
          file_count: 1,
          output_format: job.format,
          method: "native_share",
        });
      }
    }
    trackEvent("share_fallback_download", {
      file_count: 1,
      output_format: job.format,
    });
    triggerDownload(job.outputBlob, job.outputName);
    render();
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
    activeBatchId = "";
    activeBatchStartedAt = 0;
    shareNotice = "";
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

  function classifyConversionError(error) {
    if (!error) {
      return "unknown";
    }
    const message = String(error.message || error).toLowerCase();
    if (message.includes("library")) {
      return "library_load";
    }
    if (message.includes("decode")) {
      return "decode";
    }
    if (message.includes("heic")) {
      return "heic_conversion";
    }
    if (message.includes("pdf")) {
      return "pdf_conversion";
    }
    return "other";
  }

  function trackEvent(name, params) {
    if (typeof window.gtag !== "function") {
      return;
    }
    try {
      window.gtag("event", name, params || {});
    } catch (error) {
      // Silently ignore analytics errors to avoid impacting conversion flow.
    }
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

  function formatEta(seconds) {
    if (!Number.isFinite(seconds) || seconds <= 0) {
      return "Less than a second";
    }
    if (seconds < 60) {
      return `${Math.max(1, Math.round(seconds))} sec`;
    }
    const minutes = Math.floor(seconds / 60);
    const remainingSeconds = Math.round(seconds % 60);
    if (remainingSeconds === 0) {
      return `${minutes} min`;
    }
    return `${minutes} min ${remainingSeconds} sec`;
  }

  function getActiveBatchJobs() {
    if (!activeBatchId) {
      return [];
    }
    return jobs.filter((job) => job.batchId === activeBatchId);
  }

  function render() {
    resultsList.innerHTML = "";
    thumbStrip.innerHTML = "";

    jobs.forEach((job) => {
      const li = document.createElement("li");
      li.className = "result-item";

      const left = document.createElement("div");
      left.className = "result-main";

      const thumb = document.createElement("div");
      thumb.className = "result-thumb";

      if (job.status === "done" && isImageFileName(job.outputName) && job.outputUrl) {
        const img = document.createElement("img");
        img.src = job.outputUrl;
        img.alt = job.outputName || "Converted photo";
        img.loading = "lazy";
        thumb.append(img);
      } else if (job.sourcePreviewUrl) {
        const img = document.createElement("img");
        img.src = job.sourcePreviewUrl;
        img.alt = job.file.name || "Selected photo";
        img.loading = "lazy";
        thumb.append(img);
      } else {
        const placeholder = document.createElement("span");
        placeholder.className = "result-thumb-placeholder";
        placeholder.textContent = "IMG";
        thumb.append(placeholder);
      }

      const meta = document.createElement("div");
      meta.className = "result-meta";

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

      meta.append(nameLine, metaLine, statusLine);
      left.append(thumb, meta);

      const actionGroup = document.createElement("div");
      actionGroup.className = "item-actions";

      const shareItemBtn = document.createElement("button");
      shareItemBtn.className = "share-btn";
      shareItemBtn.type = "button";
      shareItemBtn.textContent = "Share or Save";
      shareItemBtn.disabled = job.status !== "done";
      shareItemBtn.addEventListener("click", async () => {
        if (job.status === "done") {
          trackEvent("share_clicked", {
            file_count: 1,
            output_format: job.format,
            source: "file_details",
          });
          await shareSingleJob(job);
        }
      });

      const downloadBtn = document.createElement("button");
      downloadBtn.className = "download-btn";
      downloadBtn.type = "button";
      downloadBtn.textContent = "Download";
      downloadBtn.disabled = job.status !== "done";
      downloadBtn.addEventListener("click", () => {
        if (job.outputBlob && job.outputName) {
          trackEvent("download_clicked", {
            file_count: 1,
            output_format: job.format,
            download_type: "single_file",
            source: "file_details",
          });
          triggerDownload(job.outputBlob, job.outputName);
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
    const activeBatchJobs = getActiveBatchJobs();
    const batchTotal = activeBatchJobs.length;
    const batchDoneCount = activeBatchJobs.filter((job) => job.status === "done").length;
    const batchErrorCount = activeBatchJobs.filter((job) => job.status === "error").length;
    const batchProcessingCount = activeBatchJobs.filter((job) => job.status === "processing").length;
    const batchQueuedCount = activeBatchJobs.filter((job) => job.status === "queued").length;
    const batchFinishedCount = batchDoneCount + batchErrorCount;
    const isBatchInProgress = batchTotal > 0 && (batchProcessingCount > 0 || batchQueuedCount > 0);

    const canShare = hasNativeFileShareCapability();
    const showSingleActionCopy = doneCount === 1;
    shareBtn.textContent = showSingleActionCopy ? "Share or Save" : "Share";
    downloadAllBtn.textContent = showSingleActionCopy ? "Download" : "Download ZIP";

    if (jobs.length === 0) {
      summary.textContent = "Step 1: Pick your photos to get started.";
      actionHint.classList.add("is-hidden");
      actionHint.textContent = "";
      clearBtn.classList.add("is-hidden");
    } else if (processingCount > 0 || queuedCount > 0) {
      const summaryDone = batchTotal > 0 ? batchDoneCount : doneCount;
      const summaryErrors = batchTotal > 0 ? batchErrorCount : errorCount;
      summary.textContent = `Working on your photos... ${summaryDone} ready${
        summaryErrors > 0 ? `, ${summaryErrors} skipped` : ""
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
        if (!canShare) {
          actionHint.textContent = "Next: tap Download above.";
        } else if (doneCount > NATIVE_SHARE_BATCH_LIMIT) {
          actionHint.textContent = `Tip: Share menu is best for up to ${NATIVE_SHARE_BATCH_LIMIT} files. Larger batches download as ZIP.`;
        } else if (isAppleMobileDevice()) {
          actionHint.textContent = "Next: tap Share or Save above. On iPhone, choose Save Image in the share menu.";
        } else {
          actionHint.textContent = "Next: tap Share or Save above.";
        }
        actionHint.classList.remove("is-hidden");
      } else {
        actionHint.classList.add("is-hidden");
        actionHint.textContent = "";
      }
      clearBtn.classList.remove("is-hidden");
    }

    if (isBatchInProgress) {
      const percent = Math.max(0, Math.min(100, Math.round((batchFinishedCount / batchTotal) * 100)));
      const elapsedSeconds = Math.max(1, (Date.now() - activeBatchStartedAt) / 1000);
      const averageSecondsPerPhoto = batchFinishedCount > 0 ? elapsedSeconds / batchFinishedCount : 0;
      const remainingPhotos = Math.max(0, batchTotal - batchFinishedCount);
      const etaSeconds = averageSecondsPerPhoto > 0 ? averageSecondsPerPhoto * remainingPhotos : 0;
      const processingLabel = `Fixing photos (${batchFinishedCount}/${batchTotal})`;

      progressWrap.classList.remove("is-hidden");
      progressLabel.textContent = processingLabel;
      progressPercent.textContent = `${percent}%`;
      progressFill.style.width = `${percent}%`;
      progressFill.parentElement?.setAttribute("aria-valuenow", String(percent));
      progressEta.textContent =
        batchFinishedCount === 0
          ? "Estimating time..."
          : `About ${formatEta(etaSeconds)} remaining`;
    } else {
      progressWrap.classList.add("is-hidden");
      progressLabel.textContent = "Fixing photos...";
      progressPercent.textContent = "0%";
      progressFill.style.width = "0%";
      progressFill.parentElement?.setAttribute("aria-valuenow", "0");
      progressEta.textContent =
        jobs.length > SLOW_BATCH_HINT_THRESHOLD
          ? `Tip: Large batches can take longer on phones. ${SLOW_BATCH_HINT_THRESHOLD} at a time is usually fastest.`
          : "Estimating time...";
    }

    afterActions.classList.toggle("is-hidden", jobs.length === 0);
    afterActions.classList.toggle("sticky-actions", doneCount > 0 && !isProcessing);
    detailsPanel.classList.toggle("is-hidden", jobs.length === 0);
    dropZone.classList.toggle("drop-zone-attention", jobs.length === 0);
    thumbStrip.classList.toggle("is-hidden", jobs.length === 0);

    const showShareFallback = doneCount > 0 && (!canShare || Boolean(shareNotice));
    shareFallback.classList.toggle("is-hidden", !showShareFallback);
    if (showShareFallback) {
      shareFallback.textContent = !canShare
        ? "Share is not supported here. Tap Download, then send from Photos or Files."
        : shareNotice;
    } else {
      shareFallback.textContent = "";
    }

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
        const more = document.createElement("button");
        more.className = "thumb-more thumb-more-btn";
        more.type = "button";
        more.textContent = `+${jobs.length - 6}`;
        more.setAttribute("aria-label", `Show ${jobs.length - 6} more photos in file details`);
        more.addEventListener("click", () => {
          detailsPanel.open = true;
          detailsPanel.classList.remove("details-panel-pulse");
          void detailsPanel.offsetWidth;
          detailsPanel.classList.add("details-panel-pulse");
          detailsPanel.scrollIntoView({ behavior: "smooth", block: "nearest" });
        });
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
