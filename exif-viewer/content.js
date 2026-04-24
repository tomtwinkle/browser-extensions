(function (root) {
  'use strict';

  const shared = root.ExifViewerShared;
  const UI_ROOT_ID = 'hover-exif-viewer-root';

  const state = {
    ui: null,
    hoveredImage: null,
    requestToken: 0,
  };

  function assignStyle(element, styles) {
    for (const [key, value] of Object.entries(styles)) {
      element.style[key] = value;
    }
    return element;
  }

  function createElement(doc, tagName, { text, attrs, styles } = {}) {
    const element = doc.createElement(tagName);
    if (text != null) element.textContent = text;
    if (attrs) {
      for (const [name, value] of Object.entries(attrs)) {
        element.setAttribute(name, value);
      }
    }
    if (styles) assignStyle(element, styles);
    return element;
  }

  function replaceChildren(element, children) {
    if (typeof element.replaceChildren === 'function') {
      element.replaceChildren(...children);
      return;
    }
    while (element.firstChild) {
      element.removeChild(element.firstChild);
    }
    for (const child of children) {
      element.appendChild(child);
    }
  }

  function ensureUi() {
    if (state.ui) return state.ui;

    const doc = root.document;
    const container = createElement(doc, 'div', {
      attrs: {
        id: UI_ROOT_ID,
      },
      styles: {
        position: 'fixed',
        top: '0',
        right: '0',
        bottom: '0',
        left: '0',
        pointerEvents: 'none',
        zIndex: '2147483647',
        fontFamily: 'system-ui, -apple-system, BlinkMacSystemFont, sans-serif',
      },
    });

    const button = createElement(doc, 'button', {
      text: 'EXIF',
      attrs: {
        type: 'button',
        'aria-label': 'View EXIF metadata',
      },
      styles: {
        position: 'fixed',
        display: 'none',
        alignItems: 'center',
        justifyContent: 'center',
        minWidth: '72px',
        height: '32px',
        padding: '0 12px',
        border: '1px solid rgba(15, 23, 42, 0.2)',
        borderRadius: '999px',
        background: 'rgba(17, 24, 39, 0.96)',
        color: '#ffffff',
        fontSize: '12px',
        fontWeight: '700',
        lineHeight: '1',
        boxShadow: '0 8px 24px rgba(15, 23, 42, 0.28)',
        cursor: 'pointer',
        pointerEvents: 'auto',
      },
    });
    button.hidden = true;

    const backdrop = createElement(doc, 'div', {
      attrs: {
        role: 'dialog',
        'aria-modal': 'true',
        'aria-label': 'EXIF metadata viewer',
      },
      styles: {
        display: 'none',
        position: 'fixed',
        top: '0',
        right: '0',
        bottom: '0',
        left: '0',
        background: 'rgba(15, 23, 42, 0.42)',
        pointerEvents: 'auto',
        padding: '24px',
        boxSizing: 'border-box',
      },
    });

    const panel = createElement(doc, 'div', {
      styles: {
        maxWidth: '720px',
        maxHeight: 'min(80vh, 720px)',
        margin: '0 auto',
        background: '#ffffff',
        color: '#0f172a',
        borderRadius: '16px',
        boxShadow: '0 24px 48px rgba(15, 23, 42, 0.24)',
        overflow: 'hidden',
        pointerEvents: 'auto',
      },
    });

    const header = createElement(doc, 'div', {
      styles: {
        display: 'flex',
        alignItems: 'flex-start',
        justifyContent: 'space-between',
        gap: '12px',
        padding: '18px 20px 12px',
        borderBottom: '1px solid #e2e8f0',
      },
    });

    const titleWrap = createElement(doc, 'div');
    const title = createElement(doc, 'div', {
      text: 'EXIF Viewer',
      styles: {
        fontSize: '18px',
        fontWeight: '700',
        lineHeight: '1.3',
      },
    });
    const subtitle = createElement(doc, 'div', {
      text: 'Hover an image and click the EXIF button to inspect its metadata.',
      styles: {
        marginTop: '4px',
        fontSize: '12px',
        color: '#475569',
        lineHeight: '1.5',
      },
    });
    titleWrap.appendChild(title);
    titleWrap.appendChild(subtitle);

    const closeButton = createElement(doc, 'button', {
      text: 'Close',
      attrs: {
        type: 'button',
        'aria-label': 'Close EXIF metadata viewer',
      },
      styles: {
        flex: '0 0 auto',
        border: '1px solid #cbd5e1',
        borderRadius: '999px',
        background: '#ffffff',
        color: '#0f172a',
        fontSize: '12px',
        fontWeight: '600',
        lineHeight: '1',
        padding: '8px 12px',
        cursor: 'pointer',
      },
    });

    header.appendChild(titleWrap);
    header.appendChild(closeButton);

    const body = createElement(doc, 'div', {
      styles: {
        padding: '18px 20px 20px',
        overflow: 'auto',
        maxHeight: 'calc(min(80vh, 720px) - 72px)',
        boxSizing: 'border-box',
      },
    });

    panel.appendChild(header);
    panel.appendChild(body);
    backdrop.appendChild(panel);
    container.appendChild(button);
    container.appendChild(backdrop);
    doc.documentElement.appendChild(container);

    button.addEventListener('click', handleButtonClick);
    closeButton.addEventListener('click', closeModal);
    backdrop.addEventListener('click', (event) => {
      if (event.target === backdrop) closeModal();
    });

    state.ui = {
      container,
      button,
      backdrop,
      panel,
      title,
      subtitle,
      body,
      closeButton,
    };
    return state.ui;
  }

  function containsNode(rootNode, target) {
    if (!rootNode || !target) return false;
    if (rootNode === target) return true;
    return typeof rootNode.contains === 'function' ? rootNode.contains(target) : false;
  }

  function findAncestorImage(node) {
    let current = node || null;
    while (current) {
      if (String(current.tagName || '').toUpperCase() === 'IMG') return current;
      current = current.parentElement || null;
    }
    return null;
  }

  function viewportWidth() {
    return root.innerWidth || root.document.documentElement.clientWidth || 1024;
  }

  function viewportHeight() {
    return root.innerHeight || root.document.documentElement.clientHeight || 768;
  }

  function imageSource(image) {
    const value =
      (typeof image?.currentSrc === 'string' && image.currentSrc) ||
      (typeof image?.src === 'string' && image.src) ||
      (typeof image?.getAttribute === 'function' && image.getAttribute('src')) ||
      '';
    return value.trim() || null;
  }

  function imageRect(image) {
    if (!image || typeof image.getBoundingClientRect !== 'function') return null;
    return image.getBoundingClientRect();
  }

  function isVisibleRect(rect) {
    return Boolean(
      rect &&
      rect.width > 0 &&
      rect.height > 0 &&
      rect.right > 0 &&
      rect.bottom > 0 &&
      rect.left < viewportWidth() &&
      rect.top < viewportHeight()
    );
  }

  function isEligibleImage(image) {
    return Boolean(image && imageSource(image) && isVisibleRect(imageRect(image)));
  }

  function showButtonForImage(image) {
    if (!isEligibleImage(image)) {
      hideButton();
      return;
    }
    const ui = ensureUi();
    state.hoveredImage = image;
    ui.button.hidden = false;
    ui.button.style.display = 'inline-flex';
    positionButton(image);
  }

  function positionButton(image) {
    const ui = ensureUi();
    const rect = imageRect(image);
    if (!isVisibleRect(rect)) {
      hideButton();
      return;
    }
    const buttonWidth = ui.button.offsetWidth || 72;
    const buttonHeight = ui.button.offsetHeight || 32;
    const left = Math.max(8, Math.min(viewportWidth() - buttonWidth - 8, rect.right - buttonWidth - 12));
    const top = Math.max(8, Math.min(viewportHeight() - buttonHeight - 8, rect.bottom - buttonHeight - 12));
    ui.button.style.left = `${Math.round(left)}px`;
    ui.button.style.top = `${Math.round(top)}px`;
  }

  function hideButton() {
    if (!state.ui) {
      state.hoveredImage = null;
      return;
    }
    state.hoveredImage = null;
    state.ui.button.hidden = true;
    state.ui.button.style.display = 'none';
  }

  function shortSourceLabel(url) {
    if (!url) return 'Unknown';
    if (url.startsWith('data:')) return 'data URL';
    if (url.startsWith('blob:')) return 'blob URL';
    return url.length > 120 ? `${url.slice(0, 117)}...` : url;
  }

  function formatByteLength(byteLength) {
    if (!Number.isFinite(byteLength) || byteLength < 0) return 'Unknown';
    if (byteLength < 1024) return `${byteLength} B`;
    if (byteLength < 1024 * 1024) return `${(byteLength / 1024).toFixed(1).replace(/\.0$/, '')} KB`;
    return `${(byteLength / (1024 * 1024)).toFixed(2).replace(/\.?0+$/, '')} MB`;
  }

  function coordinateText(value) {
    if (!Number.isFinite(value)) return 'Unknown';
    return value.toFixed(7).replace(/\.?0+$/, '');
  }

  function googleMapsUrl(gps) {
    return `https://www.google.com/maps/@${gps.latitude.toFixed(7)},${gps.longitude.toFixed(7)},17.0z`;
  }

  function openModal(titleText, subtitleText, children) {
    const ui = ensureUi();
    ui.title.textContent = titleText;
    ui.subtitle.textContent = subtitleText;
    replaceChildren(ui.body, children);
    ui.backdrop.style.display = 'block';
  }

  function closeModal() {
    if (!state.ui) return;
    state.ui.backdrop.style.display = 'none';
  }

  function paragraph(doc, text, styles) {
    return createElement(doc, 'p', {
      text,
      styles: Object.assign(
        {
          margin: '0 0 12px',
          fontSize: '14px',
          lineHeight: '1.6',
          color: '#0f172a',
        },
        styles || {}
      ),
    });
  }

  function heading(doc, text) {
    return createElement(doc, 'h3', {
      text,
      styles: {
        margin: '18px 0 10px',
        fontSize: '14px',
        fontWeight: '700',
        color: '#0f172a',
      },
    });
  }

  function detailTable(doc, rows) {
    const table = createElement(doc, 'table', {
      styles: {
        width: '100%',
        borderCollapse: 'collapse',
        tableLayout: 'fixed',
        background: '#f8fafc',
        borderRadius: '10px',
        overflow: 'hidden',
      },
    });
    const body = createElement(doc, 'tbody');

    for (const [label, value] of rows) {
      const row = createElement(doc, 'tr');
      const labelCell = createElement(doc, 'th', {
        text: label,
        styles: {
          width: '34%',
          padding: '10px 12px',
          textAlign: 'left',
          verticalAlign: 'top',
          fontSize: '12px',
          fontWeight: '700',
          color: '#334155',
          borderBottom: '1px solid #e2e8f0',
          background: '#eef2ff',
          boxSizing: 'border-box',
        },
      });
      const valueCell = createElement(doc, 'td', {
        styles: {
          padding: '10px 12px',
          fontSize: '13px',
          lineHeight: '1.55',
          color: '#0f172a',
          borderBottom: '1px solid #e2e8f0',
          wordBreak: 'break-word',
          whiteSpace: 'pre-wrap',
          boxSizing: 'border-box',
        },
      });
      if (value && typeof value === 'object' && typeof value.tagName === 'string') {
        valueCell.appendChild(value);
      } else {
        valueCell.textContent = value;
      }
      row.appendChild(labelCell);
      row.appendChild(valueCell);
      body.appendChild(row);
    }

    table.appendChild(body);
    return table;
  }

  function locationValue(doc, gps) {
    const wrapper = createElement(doc, 'div', {
      styles: {
        display: 'flex',
        flexDirection: 'column',
        gap: '4px',
      },
    });
    wrapper.appendChild(
      createElement(doc, 'div', {
        text: `${coordinateText(gps.latitude)}, ${coordinateText(gps.longitude)}`,
      })
    );
    wrapper.appendChild(
      createElement(doc, 'a', {
        text: 'Open in Google Maps',
        attrs: {
          href: googleMapsUrl(gps),
          target: '_blank',
          rel: 'noopener noreferrer',
        },
        styles: {
          color: '#2563eb',
          textDecoration: 'underline',
        },
      })
    );
    return wrapper;
  }

  function metadataSummaryRows(doc, image, metadata) {
    const rows = [
      ['Source', shortSourceLabel(metadata.sourceUrl)],
      ['Format', String(metadata.container || metadata.mimeType || 'Unknown').toUpperCase()],
      ['Size', formatByteLength(metadata.byteLength)],
    ];
    if (metadata.mimeType) rows.push(['MIME type', metadata.mimeType]);
    if (Number.isFinite(metadata?.summary?.gps?.latitude) && Number.isFinite(metadata?.summary?.gps?.longitude)) {
      rows.push(['Location', locationValue(doc, metadata.summary.gps)]);
    }
    if (Number.isFinite(image?.naturalWidth) && Number.isFinite(image?.naturalHeight)) {
      rows.push(['Natural size', `${image.naturalWidth} × ${image.naturalHeight}`]);
    }
    const rect = imageRect(image);
    if (rect) rows.push(['Displayed size', `${Math.round(rect.width)} × ${Math.round(rect.height)}`]);
    return rows;
  }

  function renderMetadata(image, metadata) {
    const doc = root.document;
    const children = [
      detailTable(doc, metadataSummaryRows(doc, image, metadata)),
    ];

    if (!metadata.hasExif || !Array.isArray(metadata.sections) || metadata.sections.length === 0) {
      children.push(
        paragraph(
          doc,
          'No EXIF metadata was found in this image. JPEG, PNG eXIf, WebP EXIF, and TIFF metadata are supported.'
        )
      );
      openModal('EXIF Viewer', 'No EXIF block was detected for this image.', children);
      return;
    }

    for (const section of metadata.sections) {
      children.push(heading(doc, section.label));
      children.push(
        detailTable(
          doc,
          section.entries.map((entry) => [entry.name, entry.displayValue])
        )
      );
    }

    openModal('EXIF Viewer', `Loaded ${metadata.sections.length} EXIF section(s).`, children);
  }

  function renderError(message) {
    const doc = root.document;
    openModal('EXIF Viewer', 'Could not inspect this image.', [
      paragraph(doc, message, {
        color: '#b91c1c',
      }),
    ]);
  }

  function runtimeMessage(message) {
    return new Promise((resolve, reject) => {
      root.chrome.runtime.sendMessage(message, (response) => {
        if (root.chrome.runtime.lastError) {
          reject(new Error(root.chrome.runtime.lastError.message));
          return;
        }
        resolve(response);
      });
    });
  }

  function normalizeMimeType(contentType) {
    return typeof contentType === 'string' ? contentType.split(';', 1)[0].trim() || null : null;
  }

  async function inspectLocally(url) {
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`Could not fetch the image (HTTP ${response.status}).`);
    }
    const bytes = new Uint8Array(await response.arrayBuffer());
    return {
      sourceUrl: response.url || url,
      mimeType: normalizeMimeType(response.headers.get('content-type')),
      byteLength: bytes.byteLength,
      ...shared.parseExifMetadata(bytes),
    };
  }

  async function inspectImage(image) {
    const url = imageSource(image);
    if (!url) throw new Error('Could not resolve the hovered image URL.');

    if (/^(blob:|data:)/i.test(url)) {
      return inspectLocally(url);
    }

    const response = await runtimeMessage({
      type: 'READ_EXIF_FROM_URL',
      url,
    });
    if (!response?.ok) {
      throw new Error(response?.error || 'Could not read EXIF metadata.');
    }
    return response.metadata;
  }

  async function handleButtonClick(event) {
    event.preventDefault?.();
    event.stopPropagation?.();
    const image = state.hoveredImage;
    if (!isEligibleImage(image)) return;

    hideButton();
    const token = ++state.requestToken;
    openModal('EXIF Viewer', 'Reading image metadata…', [
      paragraph(root.document, 'Fetching the image bytes and parsing any EXIF blocks that are present.'),
    ]);

    try {
      const metadata = await inspectImage(image);
      if (token !== state.requestToken) return;
      renderMetadata(image, metadata);
    } catch (error) {
      if (token !== state.requestToken) return;
      renderError(error.message);
    }
  }

  function handlePointerMove(event) {
    const ui = state.ui;
    if (ui && (containsNode(ui.button, event.target) || containsNode(ui.backdrop, event.target))) {
      if (state.hoveredImage) positionButton(state.hoveredImage);
      return;
    }

    const image = findAncestorImage(event.target);
    if (isEligibleImage(image)) {
      showButtonForImage(image);
      return;
    }
    hideButton();
  }

  function handleViewportChange() {
    if (isEligibleImage(state.hoveredImage) && state.ui?.button.hidden === false) {
      positionButton(state.hoveredImage);
      return;
    }
    hideButton();
  }

  function handleKeydown(event) {
    if (event.key === 'Escape') closeModal();
  }

  function init() {
    root.document.addEventListener('pointermove', handlePointerMove, true);
    root.addEventListener('scroll', handleViewportChange, true);
    root.addEventListener('resize', handleViewportChange, true);
    root.document.addEventListener('keydown', handleKeydown, true);
  }

  const api = {
    state,
    ensureUi,
    closeModal,
    handlePointerMove,
    hideButton,
    imageSource,
    inspectImage,
    isEligibleImage,
    positionButton,
    renderError,
    renderMetadata,
  };

  root.ExifViewerContent = api;
  init();
})(typeof globalThis !== 'undefined' ? globalThis : this);
