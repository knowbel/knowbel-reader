(() => {
  try {
    const text = document.body?.innerText || "";
    if (/just a moment|verify you are human|enable javascript and cookies|checking your browser/i.test(document.title + " " + text.slice(0, 1500)) && text.length < 5000) {
      return { error: "Finish the site's verification in this window, then choose Read in Knowbel again." };
    }
    if (document.contentType === "application/pdf") return { url: location.href, contentType: "application/pdf", html: "" };
    if (document.readyState === "loading") return { error: "The page is still loading. Wait for the article, then choose Read in Knowbel again." };
    if (!document.body || text.trim().length < 40) return { error: "The page is still loading or contains no readable text. Wait for the article, then try again." };
    if (document.querySelectorAll("*").length > 100000) return { error: "This page is too large to capture. Open a single article or section." };
    const clone = document.documentElement.cloneNode(true);
    const originals = [...document.querySelectorAll("img")], pictures = [...clone.querySelectorAll("img")];
    const canvases = [...document.querySelectorAll("canvas")], copies = [...clone.querySelectorAll("canvas")];
    const svgs = [...document.querySelectorAll("svg")], cloned = [...clone.querySelectorAll("svg")];
    clone.querySelectorAll("[data-knowbel-import-ui], [data-knowbel-ui], base").forEach(node => node.remove());
    const base = document.createElement("base");
    base.href = document.baseURI;
    clone.querySelector("head")?.prepend(base);
    // Metadata and nonexecutable math survive. Executable scripts and their
    // duplicated hydration payloads are unnecessary in the saved article.
    clone.querySelectorAll("script").forEach(node => {
      if (!/^(application\/ld\+json|math\/tex|math\/asciimath)/i.test(node.type || "")) node.remove();
    });
    clone.querySelectorAll("input, textarea, select, [contenteditable]:not([contenteditable=false])").forEach(node => node.remove());
    clone.querySelectorAll("*").forEach(node => {
      for (const attr of [...node.attributes]) if (/^on/i.test(attr.name)) node.removeAttribute(attr.name);
    });
    let imageBytes = 0;
    // Resolve picture/srcset/lazy sources using what the browser actually
    // displayed. A blob URL must become pixels before its window is closed.
    for (let i = 0; i < originals.length; i++) {
      const original = originals[i], copy = pictures[i];
      if (!copy || !clone.contains(copy)) continue;
      let src = original.currentSrc || original.src;
      if (i < 128 && imageBytes < 8 * 1024 * 1024 && src && (src.startsWith("blob:") || new URL(src, location.href).origin === location.origin) && original.complete && original.naturalWidth) {
        try {
          const canvas = document.createElement("canvas");
          const scale = Math.min(1, 2000 / Math.max(original.naturalWidth, original.naturalHeight));
          canvas.width = Math.max(1, Math.round(original.naturalWidth * scale));
          canvas.height = Math.max(1, Math.round(original.naturalHeight * scale));
          canvas.getContext("2d").drawImage(original, 0, 0, canvas.width, canvas.height);
          src = canvas.toDataURL("image/png");
          imageBytes += src.length;
        } catch { /* The importer will retain a source link for missing images. */ }
      }
      if (src) copy.setAttribute("src", src);
      copy.removeAttribute("srcset");
      copy.parentElement?.querySelectorAll("source[srcset]").forEach(source => source.remove());
    }
    for (let i = 0; i < canvases.length; i++) {
      const original = canvases[i], copy = copies[i];
      if (!copy || !clone.contains(copy) || !original.width || !original.height) continue;
      try {
        if (i >= 128 || imageBytes >= 8 * 1024 * 1024) { copy.replaceWith(document.createTextNode(original.getAttribute("aria-label") || original.textContent || "Figure unavailable")); continue; }
        const image = document.createElement("img");
        const scaled = document.createElement("canvas"), scale = Math.min(1, 2000 / Math.max(original.width, original.height));
        scaled.width = Math.max(1, Math.round(original.width * scale)); scaled.height = Math.max(1, Math.round(original.height * scale));
        scaled.getContext("2d").drawImage(original, 0, 0, scaled.width, scaled.height);
        image.src = scaled.toDataURL("image/png"); imageBytes += image.src.length;
        image.alt = original.getAttribute("aria-label") || original.textContent || "Figure";
        image.id = original.id;
        copy.replaceWith(image);
      } catch { /* Canvas fallback text remains available to extraction. */ }
    }
    // SVG presentation often comes from CSS or an animation's current state.
    const properties = ["fill", "stroke", "stroke-width", "opacity", "font-family", "font-size", "font-weight", "color", "visibility"];
    for (let i = 0; i < svgs.length; i++) {
      if (!cloned[i] || !clone.contains(cloned[i]) || svgs[i].getBoundingClientRect().width < 48) continue;
      const original = [svgs[i], ...svgs[i].querySelectorAll("*")], nodes = [cloned[i], ...cloned[i].querySelectorAll("*")];
      for (let j = 0; j < original.length; j++) {
        if (!nodes[j]) continue;
        const style = getComputedStyle(original[j]);
        for (const property of properties) nodes[j].setAttribute(property, style.getPropertyValue(property));
      }
    }
    const html = "<!doctype html>" + clone.outerHTML;
    if (html.length > 16 * 1024 * 1024) return { error: "This page is too large to capture. Open a single article or section." };
    return { url: location.href, title: document.title, html, contentType: "text/html" };
  } catch (error) { return { error: "Couldn't capture this page: " + String(error) }; }
})()
