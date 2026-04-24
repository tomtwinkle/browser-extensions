(function (root) {
  'use strict';

  const shared = root.ExifViewerShared;
  const UI_ROOT_ID = 'hover-exif-viewer-root';

  const state = {
    ui: null,
    hoveredImage: null,
    requestToken: 0,
    activeTooltip: null,
    tooltipHandlersBound: false,
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
        width: 'min(1100px, calc(100vw - 48px))',
        maxWidth: '1100px',
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
    bindGlobalTooltipHandlers();

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

  function bindGlobalTooltipHandlers() {
    if (state.tooltipHandlersBound) return;

    if (typeof root.document?.addEventListener === 'function') {
      root.document.addEventListener('click', (event) => {
        if (!state.activeTooltip) return;
        if (containsNode(state.activeTooltip.wrapper, event.target)) return;
        hideHelpTooltip(state.activeTooltip, { force: true });
      });
    }

    if (typeof root.addEventListener === 'function') {
      root.addEventListener('keydown', (event) => {
        if (event.key === 'Escape' && state.activeTooltip) {
          hideHelpTooltip(state.activeTooltip, { force: true });
        }
      });
    }

    state.tooltipHandlersBound = true;
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

  function metricText(value, unit, digits = 2) {
    if (!Number.isFinite(value)) return 'Unknown';
    return `${value.toFixed(digits).replace(/\.?0+$/, '')} ${unit}`;
  }

  function openModal(titleText, subtitleText, children) {
    const ui = ensureUi();
    closeActiveTooltip();
    ui.title.textContent = titleText;
    ui.subtitle.textContent = subtitleText;
    replaceChildren(ui.body, children);
    ui.backdrop.style.display = 'block';
  }

  function closeModal() {
    if (!state.ui) return;
    closeActiveTooltip();
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

  function isElementNode(value) {
    return Boolean(value && typeof value === 'object' && typeof value.tagName === 'string');
  }

  function setHelpTooltipOpen(tooltipState, isOpen) {
    if (!tooltipState) return;
    tooltipState.isOpen = isOpen;
    tooltipState.bubble.hidden = !isOpen;
    tooltipState.bubble.style.display = isOpen ? 'block' : 'none';
    tooltipState.button.setAttribute('aria-expanded', isOpen ? 'true' : 'false');
  }

  function hideHelpTooltip(tooltipState, { force = false } = {}) {
    if (!tooltipState || (!force && tooltipState.pinned)) return;
    tooltipState.pinned = false;
    setHelpTooltipOpen(tooltipState, false);
    if (state.activeTooltip === tooltipState) {
      state.activeTooltip = null;
    }
  }

  function showHelpTooltip(tooltipState, { pinned = false } = {}) {
    if (!tooltipState) return;
    if (state.activeTooltip && state.activeTooltip !== tooltipState) {
      hideHelpTooltip(state.activeTooltip, { force: true });
    }
    tooltipState.pinned = pinned;
    setHelpTooltipOpen(tooltipState, true);
    state.activeTooltip = tooltipState;
  }

  function closeActiveTooltip() {
    if (!state.activeTooltip) return;
    hideHelpTooltip(state.activeTooltip, { force: true });
  }

  function helpBadge(doc, description) {
    const wrapper = createElement(doc, 'span', {
      styles: {
        position: 'relative',
        display: 'inline-flex',
        alignItems: 'center',
        flex: '0 0 auto',
      },
    });
    const button = createElement(doc, 'button', {
      text: '?',
      attrs: {
        type: 'button',
        'aria-label': 'Show field explanation',
        'aria-expanded': 'false',
      },
      styles: {
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        width: '16px',
        height: '16px',
        padding: '0',
        border: 'none',
        borderRadius: '999px',
        background: '#cbd5e1',
        color: '#0f172a',
        fontSize: '11px',
        fontWeight: '700',
        cursor: 'help',
        marginTop: '1px',
      },
    });
    const bubble = createElement(doc, 'div', {
      text: description,
      attrs: {
        role: 'tooltip',
      },
      styles: {
        display: 'none',
        position: 'absolute',
        top: 'calc(100% + 6px)',
        right: '0',
        zIndex: '1',
        minWidth: '220px',
        maxWidth: '280px',
        padding: '8px 10px',
        borderRadius: '10px',
        background: '#0f172a',
        color: '#f8fafc',
        fontSize: '12px',
        fontWeight: '500',
        lineHeight: '1.5',
        boxShadow: '0 12px 28px rgba(15, 23, 42, 0.28)',
      },
    });
    bubble.hidden = true;

    const tooltipState = {
      wrapper,
      button,
      bubble,
      pinned: false,
      isOpen: false,
    };

    button.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      if (tooltipState.isOpen && tooltipState.pinned) {
        hideHelpTooltip(tooltipState, { force: true });
        return;
      }
      showHelpTooltip(tooltipState, { pinned: true });
    });
    button.addEventListener('mouseenter', () => showHelpTooltip(tooltipState));
    button.addEventListener('focus', () => showHelpTooltip(tooltipState));
    wrapper.addEventListener('mouseleave', () => hideHelpTooltip(tooltipState));
    button.addEventListener('blur', () => hideHelpTooltip(tooltipState));

    wrapper.appendChild(button);
    wrapper.appendChild(bubble);
    return wrapper;
  }

  function metadataLabel(doc, entry) {
    const wrapper = createElement(doc, 'div', {
      styles: {
        display: 'flex',
        alignItems: 'flex-start',
        gap: '8px',
      },
    });
    const textWrap = createElement(doc, 'div');
    textWrap.appendChild(
      createElement(doc, 'div', {
        text: entry.title || entry.name,
      })
    );
    if (entry.name && entry.title && entry.title !== entry.name) {
      textWrap.appendChild(
        createElement(doc, 'div', {
          text: entry.name,
          styles: {
            marginTop: '2px',
            fontSize: '11px',
            fontWeight: '500',
            color: '#64748b',
          },
        })
      );
    }
    wrapper.appendChild(textWrap);
    if (entry.description) {
      wrapper.appendChild(helpBadge(doc, entry.description));
    }
    return wrapper;
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
      if (isElementNode(label)) {
        labelCell.appendChild(label);
      } else {
        labelCell.textContent = label;
      }
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
      if (isElementNode(value)) {
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
    if (Number.isFinite(gps.altitude)) {
      wrapper.appendChild(
        createElement(doc, 'div', {
          text: `Altitude: ${metricText(gps.altitude, 'm')}`,
          styles: {
            color: '#475569',
          },
        })
      );
    }
    if (gps.timestamp) {
      wrapper.appendChild(
        createElement(doc, 'div', {
          text: `GPS time: ${gps.timestamp}`,
          styles: {
            color: '#475569',
          },
        })
      );
    }
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

  function xmpEditor(doc, packet) {
    const editor = createElement(doc, 'textarea', {
      attrs: {
        readonly: 'readonly',
        spellcheck: 'false',
        'aria-label': `${packet.label} binary editor`,
      },
      styles: {
        width: '100%',
        minHeight: '280px',
        padding: '12px',
        border: '1px solid #cbd5e1',
        borderRadius: '12px',
        boxSizing: 'border-box',
        background: '#0f172a',
        color: '#e2e8f0',
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
        fontSize: '12px',
        lineHeight: '1.6',
        resize: 'vertical',
      },
    });
    editor.value = packet.hexDump;
    editor.textContent = packet.hexDump;
    return editor;
  }

  function xmpPropertiesView(doc, packet) {
    if (!Array.isArray(packet.properties) || packet.properties.length === 0) {
      return paragraph(
        doc,
        'No structured XMP properties were decoded from this packet, but the raw bytes are shown in the binary editor.',
        {
          margin: '0',
        }
      );
    }
    return detailTable(
      doc,
      packet.properties.map((property) => [property.path, property.value])
    );
  }

  function xmpPacketView(doc, packet) {
    const wrapper = createElement(doc, 'div', {
      styles: {
        marginTop: '16px',
        padding: '16px',
        border: '1px solid #cbd5e1',
        borderRadius: '14px',
        background: '#f8fafc',
      },
    });
    wrapper.appendChild(
      createElement(doc, 'div', {
        text: `${packet.label} (${formatByteLength(packet.byteLength)})`,
        styles: {
          marginBottom: '12px',
          fontSize: '13px',
          fontWeight: '700',
          color: '#0f172a',
        },
      })
    );

    const grid = createElement(doc, 'div', {
      styles: {
        display: 'grid',
        gridTemplateColumns: 'repeat(2, minmax(0, 1fr))',
        gap: '16px',
        alignItems: 'start',
      },
    });

    const binaryPane = createElement(doc, 'div');
    binaryPane.appendChild(
      createElement(doc, 'div', {
        text: 'Binary editor',
        styles: {
          marginBottom: '8px',
          fontSize: '12px',
          fontWeight: '700',
          color: '#334155',
        },
      })
    );
    binaryPane.appendChild(xmpEditor(doc, packet));

    const decodedPane = createElement(doc, 'div');
    decodedPane.appendChild(
      createElement(doc, 'div', {
        text: 'Decoded XMP',
        styles: {
          marginBottom: '8px',
          fontSize: '12px',
          fontWeight: '700',
          color: '#334155',
        },
      })
    );
    decodedPane.appendChild(xmpPropertiesView(doc, packet));

    grid.appendChild(binaryPane);
    grid.appendChild(decodedPane);
    wrapper.appendChild(grid);
    return wrapper;
  }

  function xmpDecodeSection(doc, xmp) {
    const wrapper = createElement(doc, 'div', {
      styles: {
        marginTop: '16px',
      },
    });
    const button = createElement(doc, 'button', {
      text: `Decode XMP (${xmp.packetCount})`,
      attrs: {
        type: 'button',
      },
      styles: {
        border: '1px solid #cbd5e1',
        borderRadius: '999px',
        background: '#ffffff',
        color: '#0f172a',
        fontSize: '12px',
        fontWeight: '700',
        lineHeight: '1',
        padding: '10px 14px',
        cursor: 'pointer',
      },
    });

    const panel = createElement(doc, 'div', {
      styles: {
        display: 'none',
      },
    });

    button.addEventListener('click', () => {
      const isOpen = panel.style.display !== 'none';
      panel.style.display = isOpen ? 'none' : 'block';
      button.textContent = isOpen ? `Decode XMP (${xmp.packetCount})` : 'Hide XMP';
    });

    panel.appendChild(
      paragraph(
        doc,
        'XMP packets are decoded from the original image bytes. The left pane shows a hex-style binary editor view; the right pane shows decoded XML properties.',
        {
          marginTop: '12px',
        }
      )
    );
    xmp.packets.forEach((packet) => panel.appendChild(xmpPacketView(doc, packet)));

    wrapper.appendChild(button);
    wrapper.appendChild(panel);
    return wrapper;
  }

  function metadataSummaryRows(doc, image, metadata) {
    const rows = [];
    if (metadata?.summary?.camera?.display) rows.push(['Camera', metadata.summary.camera.display]);
    if (metadata?.summary?.lens?.display) rows.push(['Lens', metadata.summary.lens.display]);
    if (metadata?.summary?.capture?.display) rows.push(['Captured', metadata.summary.capture.display]);
    if (metadata?.summary?.exposure?.display) rows.push(['Exposure', metadata.summary.exposure.display]);
    if (Number.isFinite(metadata?.summary?.gps?.latitude) && Number.isFinite(metadata?.summary?.gps?.longitude)) {
      rows.push(['Location', locationValue(doc, metadata.summary.gps)]);
    }
    if (metadata?.summary?.image?.size) rows.push(['EXIF image size', metadata.summary.image.size]);
    if (metadata?.summary?.image?.orientation) rows.push(['Orientation', metadata.summary.image.orientation]);
    if (metadata?.summary?.software?.display) rows.push(['Software', metadata.summary.software.display]);
    rows.push(['Source', shortSourceLabel(metadata.sourceUrl)]);
    rows.push(['Format', String(metadata.container || metadata.mimeType || 'Unknown').toUpperCase()]);
    rows.push(['Size', formatByteLength(metadata.byteLength)]);
    if (metadata.mimeType) rows.push(['MIME type', metadata.mimeType]);
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

    if (metadata?.xmp?.hasXmp) {
      children.push(xmpDecodeSection(doc, metadata.xmp));
    }

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
          section.entries.map((entry) => [metadataLabel(doc, entry), entry.displayValue])
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
