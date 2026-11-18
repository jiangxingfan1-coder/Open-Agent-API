// Open Agent API showcase interactions. Progressive enhancement only: without this script,
// every section, code block and screenshot remains readable. Zero external requests.
(() => {
  'use strict';
  const doc = document;
  const root = doc.documentElement;
  const themeApi = window.__oaaTheme;
  const reducedMotion =
    window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  // ── 1. Theme toggle, system sync & themed video switcher ──────────────────
  const toggles = [...doc.querySelectorAll('[data-theme-toggle]')];
  const syncThemedVideos = () => {
    const active = themeApi ? themeApi.effective() : 'light';
    doc.querySelectorAll('video[data-src-light][data-src-dark]').forEach((video) => {
      const nextSrc = active === 'dark' ? video.dataset.srcDark : video.dataset.srcLight;
      const nextPoster = active === 'dark' ? video.dataset.posterDark : video.dataset.posterLight;
      if (nextPoster && video.getAttribute('poster') !== nextPoster) {
        video.setAttribute('poster', nextPoster);
      }
      const source = video.querySelector('source');
      if (source && nextSrc && source.getAttribute('src') !== nextSrc) {
        const wasLoaded = video.preload !== 'none';
        const wasPlaying = !video.paused;
        const resumeAt = video.currentTime || 0;
        source.setAttribute('src', nextSrc);
        if (wasLoaded) {
          video.load();
          video.addEventListener(
            'loadedmetadata',
            () => {
              if (resumeAt > 0 && resumeAt < (video.duration || Infinity)) {
                video.currentTime = resumeAt;
              }
              if (wasPlaying) video.play().catch(() => {});
            },
            { once: true },
          );
        }
      }
    });
  };

  const updateToggles = () => {
    const active = themeApi ? themeApi.effective() : 'light';
    root.setAttribute('data-resolved-theme', active);
    for (const btn of toggles) {
      const toLight = btn.dataset.labelLight || 'Switch to light theme';
      const toDark = btn.dataset.labelDark || 'Switch to dark theme';
      const label = active === 'dark' ? toLight : toDark;
      btn.setAttribute('aria-label', label);
      btn.setAttribute('title', label);
      btn.setAttribute('aria-pressed', active === 'dark' ? 'true' : 'false');
    }
    syncThemedVideos();
  };

  if (toggles.length && themeApi) {
    updateToggles();
    themeApi.syncPictures(root.getAttribute('data-theme'));
    for (const btn of toggles) {
      btn.addEventListener('click', () => {
        const next = themeApi.effective() === 'dark' ? 'light' : 'dark';
        themeApi.apply(next);
        updateToggles();
      });
    }
    if (window.matchMedia) {
      const mq = window.matchMedia('(prefers-color-scheme: dark)');
      if (mq.addEventListener) {
        mq.addEventListener('change', () => {
          if (!root.getAttribute('data-theme')) updateToggles();
        });
      }
    }
  }

  // ── 2. Sticky header elevation & hairline scroll progress ──────────────────
  const head = doc.querySelector('.site-head');
  const progressBar = doc.querySelector('[data-scroll-progress]');
  if (head || progressBar) {
    const onScroll = () => {
      const y = window.scrollY;
      if (head) head.classList.toggle('is-scrolled', y > 10);
      if (progressBar) {
        const max = doc.documentElement.scrollHeight - window.innerHeight;
        const ratio = max > 0 ? Math.min(1, Math.max(0, y / max)) : 0;
        progressBar.style.transform = `scaleX(${ratio.toFixed(4)})`;
      }
    };
    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', onScroll, { passive: true });
  }

  // ── 3. Hero multi-stage: Console Overview <-> Onboarding Video <-> Workbench Video ──
  doc.querySelectorAll('[data-hero-stage]').forEach((stage) => {
    const modeBtns = [...stage.querySelectorAll('[data-stage-mode]')];
    const panes = [...stage.querySelectorAll('[data-stage-pane]')];
    if (!modeBtns.length || !panes.length) return;

    const pauseAllVideos = (exceptPane = null) => {
      for (const p of panes) {
        if (p === exceptPane) continue;
        const v = p.querySelector('video');
        if (v && !v.paused) v.pause();
      }
    };

    const wireVideoPane = (pane) => {
      const video = pane.querySelector('video');
      if (!video) return;
      const playToggle = pane.querySelector('[data-video-toggle]');
      const playLabel = pane.querySelector('[data-video-toggle-label]');
      const replayBtn = pane.querySelector('[data-video-replay]');
      const videoBar = pane.querySelector('[data-video-progress]');
      const pauseText = (playToggle && playToggle.dataset.labelPause) || 'Pause';
      const playText = (playToggle && playToggle.dataset.labelPlay) || 'Play';

      const syncUi = () => {
        const paused = video.paused;
        if (playToggle) playToggle.dataset.playing = paused ? 'false' : 'true';
        if (playLabel) playLabel.textContent = paused ? playText : pauseText;
      };

      if (playToggle) {
        playToggle.addEventListener('click', () => {
          if (video.paused) video.play().catch(() => {});
          else video.pause();
        });
      }
      if (replayBtn) {
        replayBtn.addEventListener('click', () => {
          video.currentTime = 0;
          video.play().catch(() => {});
        });
      }
      video.addEventListener('click', () => {
        if (video.paused) video.play().catch(() => {});
        else video.pause();
      });
      video.addEventListener('play', syncUi);
      video.addEventListener('pause', syncUi);
      video.addEventListener('timeupdate', () => {
        if (videoBar && video.duration > 0) {
          const pct = Math.min(1, Math.max(0, video.currentTime / video.duration));
          videoBar.style.transform = `scaleX(${pct.toFixed(4)})`;
        }
      });
      pane._syncVideoUi = syncUi;
    };

    panes.forEach(wireVideoPane);

    const switchStage = (mode, autoPlay = false) => {
      stage.dataset.activeMode = mode;
      for (const b of modeBtns) {
        const active = b.dataset.stageMode === mode;
        b.classList.toggle('is-active', active);
        b.setAttribute('aria-selected', active ? 'true' : 'false');
      }
      const activePane = panes.find((p) => p.dataset.stagePane === mode) || panes[0];
      pauseAllVideos(activePane);
      for (const p of panes) {
        p.hidden = p !== activePane;
      }
      const video = activePane.querySelector('video');
      if (video) {
        if (video.preload === 'none') video.preload = 'metadata';
        const source = video.querySelector('source');
        const srcAttr = source && source.getAttribute('src');
        const expected = srcAttr ? new URL(srcAttr, doc.baseURI).href : '';
        if (expected && video.currentSrc !== expected) {
          video.load();
        }
        if (autoPlay) video.play().catch(() => {});
        if (activePane._syncVideoUi) activePane._syncVideoUi();
      }
    };

    modeBtns.forEach((b) => {
      b.addEventListener('click', () => {
        const mode = b.dataset.stageMode;
        switchStage(mode, mode !== 'shot');
      });
    });

    doc.querySelectorAll('[data-watch-demo]').forEach((trigger) => {
      trigger.addEventListener('click', (ev) => {
        ev.preventDefault();
        const targetMode = trigger.dataset.watchDemo || 'onboarding';
        stage.scrollIntoView({ behavior: reducedMotion ? 'auto' : 'smooth', block: 'center' });
        switchStage(targetMode, true);
      });
    });
  });

  // ── 4. Clipboard helper & copy buttons ─────────────────────────────────────
  const copyText = async (text) => {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      const area = doc.createElement('textarea');
      area.value = text;
      area.setAttribute('readonly', '');
      area.style.position = 'fixed';
      area.style.opacity = '0';
      doc.body.append(area);
      area.select();
      let ok = false;
      try {
        ok = doc.execCommand('copy');
      } catch {
        ok = false;
      }
      area.remove();
      return ok;
    }
  };

  const extractCodeText = (panel) => {
    const lines = [...panel.querySelectorAll('.l:not(.del)')];
    if (lines.length) {
      return lines
        .map((line) => line.textContent.replace(/^\s$/, ''))
        .join('\n')
        .trim();
    }
    const pre = panel.querySelector('pre');
    return pre ? pre.textContent.trim() : '';
  };

  doc.querySelectorAll('[data-copy-btn]').forEach((btn) => {
    const labelEl = btn.querySelector('[data-copy-label]') || btn;
    const defaultLabel = btn.dataset.copyDefault || labelEl.textContent;
    const copiedLabel = btn.dataset.copyDone || 'Copied';
    let timer = null;

    btn.addEventListener('click', async () => {
      let text = btn.dataset.copyValue || '';
      if (!text && btn.dataset.copyTarget) {
        const target = doc.getElementById(btn.dataset.copyTarget);
        if (target) text = extractCodeText(target);
      }
      if (!text) {
        const sandbox = btn.closest('[data-code-sandbox]');
        if (sandbox) {
          const activePanel = sandbox.querySelector('[data-code-panel]:not([hidden])');
          if (activePanel) text = extractCodeText(activePanel);
        }
      }
      if (!text) return;
      await copyText(text);
      btn.classList.add('is-copied');
      labelEl.textContent = copiedLabel;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        btn.classList.remove('is-copied');
        labelEl.textContent = defaultLabel;
      }, 1700);
    });
  });

  // ── 5. Multi-protocol code sandbox tabs ────────────────────────────────────
  doc.querySelectorAll('[data-code-sandbox]').forEach((sandbox) => {
    const tabs = [...sandbox.querySelectorAll('[role="tab"]')];
    const panels = [...sandbox.querySelectorAll('[data-code-panel]')];
    if (!tabs.length || !panels.length) return;
    sandbox.classList.add('is-enhanced');

    const activate = (targetTab, moveFocus = false) => {
      const key = targetTab.dataset.tab;
      for (const tab of tabs) {
        const selected = tab === targetTab;
        tab.setAttribute('aria-selected', selected ? 'true' : 'false');
        tab.tabIndex = selected ? 0 : -1;
      }
      for (const panel of panels) {
        panel.hidden = panel.dataset.codePanel !== key;
      }
      if (moveFocus) targetTab.focus();
    };

    const initial = tabs.find((t) => t.getAttribute('aria-selected') === 'true') || tabs[0];
    activate(initial, false);

    tabs.forEach((tab, idx) => {
      tab.addEventListener('click', () => activate(tab, false));
      tab.addEventListener('keydown', (ev) => {
        if (ev.key === 'ArrowRight' || ev.key === 'ArrowLeft') {
          ev.preventDefault();
          const dir = ev.key === 'ArrowRight' ? 1 : -1;
          const next = tabs[(idx + dir + tabs.length) % tabs.length];
          activate(next, true);
        } else if (ev.key === 'Home') {
          ev.preventDefault();
          activate(tabs[0], true);
        } else if (ev.key === 'End') {
          ev.preventDefault();
          activate(tabs[tabs.length - 1], true);
        }
      });
    });
  });

  // ── 6. Interactive Human-in-the-Loop approval demo ─────────────────────────
  doc.querySelectorAll('[data-hitl-demo]').forEach((demo) => {
    const badge = demo.querySelector('[data-hitl-badge]');
    const badgeText = demo.querySelector('[data-hitl-badge-text]');
    const approveBtn = demo.querySelector('[data-hitl-approve]');
    const denyBtn = demo.querySelector('[data-hitl-deny]');
    const resetBtn = demo.querySelector('[data-hitl-reset]');
    const controls = demo.querySelector('[data-hitl-controls]');
    const stepGate = demo.querySelector('[data-hitl-step="gate"]');
    const stepGateNote = demo.querySelector('[data-hitl-gate-note]');
    const stepNextWaiting = demo.querySelector('[data-hitl-step="waiting"]');
    const stepNextApproved = demo.querySelector('[data-hitl-step="approved"]');
    const stepNextDenied = demo.querySelector('[data-hitl-step="denied"]');
    const live = demo.querySelector('[data-hitl-live]');

    if (!approveBtn || !denyBtn || !resetBtn) return;

    let timer = null;
    const labels = {
      awaiting: demo.dataset.stateAwaiting || 'Awaiting approval',
      running: demo.dataset.stateRunning || 'Running',
      completed: demo.dataset.stateCompleted || 'Completed',
      denied: demo.dataset.stateDenied || 'Completed (read-only)',
      gatePending: demo.dataset.gatePending || '',
      gateApproved: demo.dataset.gateApproved || '',
      gateDenied: demo.dataset.gateDenied || '',
    };

    const setBadge = (tone, text) => {
      if (badge) badge.dataset.tone = tone;
      if (badgeText) badgeText.textContent = text;
    };

    const setState = (state) => {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      demo.dataset.state = state;

      if (state === 'awaiting') {
        setBadge('cin', labels.awaiting);
        if (stepGate) stepGate.dataset.stepStatus = 'pending';
        if (stepGateNote && labels.gatePending) stepGateNote.textContent = labels.gatePending;
        if (controls) controls.hidden = false;
        resetBtn.hidden = true;
        if (stepNextWaiting) stepNextWaiting.hidden = false;
        if (stepNextApproved) stepNextApproved.hidden = true;
        if (stepNextDenied) stepNextDenied.hidden = true;
        if (live) live.textContent = labels.awaiting;
        return;
      }

      if (controls) controls.hidden = true;
      if (stepNextWaiting) stepNextWaiting.hidden = true;

      if (state === 'approving') {
        setBadge('tide', labels.running);
        if (stepGate) stepGate.dataset.stepStatus = 'done';
        if (stepGateNote && labels.gateApproved) stepGateNote.textContent = labels.gateApproved;
        const finish = () => {
          demo.dataset.state = 'completed';
          setBadge('moss', labels.completed);
          if (stepNextApproved) stepNextApproved.hidden = false;
          resetBtn.hidden = false;
          if (live) live.textContent = labels.completed;
        };
        if (reducedMotion) finish();
        else timer = setTimeout(finish, 480);
        return;
      }

      if (state === 'denying') {
        setBadge('tide', labels.running);
        if (stepGate) stepGate.dataset.stepStatus = 'denied';
        if (stepGateNote && labels.gateDenied) stepGateNote.textContent = labels.gateDenied;
        const finish = () => {
          demo.dataset.state = 'denied';
          setBadge('neutral', labels.denied);
          if (stepNextDenied) stepNextDenied.hidden = false;
          resetBtn.hidden = false;
          if (live) live.textContent = labels.denied;
        };
        if (reducedMotion) finish();
        else timer = setTimeout(finish, 360);
      }
    };

    approveBtn.addEventListener('click', () => setState('approving'));
    denyBtn.addEventListener('click', () => setState('denying'));
    resetBtn.addEventListener('click', () => setState('awaiting'));
  });

  // ── 7. Interactive capability matrix filter (#agents) ──────────────────────
  doc.querySelectorAll('[data-matrix-section]').forEach((sec) => {
    const filterBtns = [...sec.querySelectorAll('[data-cap-filter]')];
    const items = [...sec.querySelectorAll('[data-caps]')];
    const countNode = sec.querySelector('[data-cap-count]');
    if (!filterBtns.length || !items.length) return;

    const applyFilter = (cap) => {
      let matched = 0;
      for (const btn of filterBtns) {
        const on = btn.dataset.capFilter === cap;
        btn.classList.toggle('is-active', on);
        btn.setAttribute('aria-pressed', on ? 'true' : 'false');
      }
      for (const li of items) {
        const tokens = (li.dataset.caps || '').split(/\s+/);
        const hit = cap === 'all' || tokens.includes(cap);
        if (hit) matched++;
        li.classList.toggle('is-matched', cap !== 'all' && hit);
        li.classList.toggle('is-dimmed', cap !== 'all' && !hit);
      }
      if (countNode) {
        if (cap === 'all') {
          countNode.textContent = countNode.dataset.allLabel || '';
        } else {
          const tpl = countNode.dataset.matchTemplate || '{n} matched';
          countNode.textContent = tpl.replace('{n}', String(matched));
        }
      }
    };

    filterBtns.forEach((btn) => {
      btn.addEventListener('click', () => {
        const current = btn.classList.contains('is-active') ? btn.dataset.capFilter : '';
        applyFilter(current && current !== 'all' ? 'all' : btn.dataset.capFilter);
      });
    });
  });

  // ── 8. Screenshot glassmorphic lightbox zoom ───────────────────────────────
  const lightbox = doc.querySelector('[data-lightbox]');
  if (lightbox && typeof lightbox.showModal === 'function') {
    const lbImg = lightbox.querySelector('[data-lightbox-img]');
    const lbCap = lightbox.querySelector('[data-lightbox-caption]');
    const lbClose = lightbox.querySelector('[data-lightbox-close]');

    doc.querySelectorAll('[data-zoomable]').forEach((shot) => {
      shot.tabIndex = 0;
      shot.setAttribute('role', 'button');
      const openZoom = () => {
        const img = shot.querySelector('img');
        if (!img || !lbImg) return;
        lbImg.src = img.currentSrc || img.src;
        lbImg.alt = img.alt || '';
        const fig = shot.closest('figure');
        const cap = fig && fig.querySelector('figcaption');
        if (lbCap) lbCap.textContent = cap ? cap.textContent.trim() : img.alt || '';
        lightbox.showModal();
      };
      shot.addEventListener('click', openZoom);
      shot.addEventListener('keydown', (ev) => {
        if (ev.key === 'Enter' || ev.key === ' ') {
          ev.preventDefault();
          openZoom();
        }
      });
    });

    if (lbClose) lbClose.addEventListener('click', () => lightbox.close());
    lightbox.addEventListener('click', (ev) => {
      if (ev.target === lightbox) lightbox.close();
    });
  }

  // ── 9. Subtle cursor-tracking Tide spotlight on cards ──────────────────────
  if (!reducedMotion) {
    doc.querySelectorAll('.install-card, .cap-card').forEach((card) => {
      card.addEventListener(
        'pointermove',
        (ev) => {
          const r = card.getBoundingClientRect();
          card.style.setProperty('--mx', `${Math.round(ev.clientX - r.left)}px`);
          card.style.setProperty('--my', `${Math.round(ev.clientY - r.top)}px`);
        },
        { passive: true },
      );
    });
  }

  // ── 10. Subtle staggered scroll reveal ─────────────────────────────────────
  const reveals = [...doc.querySelectorAll('[data-reveal]')];
  if (reveals.length) {
    if (reducedMotion || !('IntersectionObserver' in window)) {
      for (const el of reveals) el.classList.add('is-visible');
    } else {
      const io = new IntersectionObserver(
        (entries) => {
          for (const entry of entries) {
            if (entry.isIntersecting) {
              entry.target.classList.add('is-visible');
              io.unobserve(entry.target);
            }
          }
        },
        { threshold: 0.08, rootMargin: '0px 0px -28px 0px' },
      );
      for (const el of reveals) io.observe(el);
    }
  }
})();
