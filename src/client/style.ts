/** Toolbar styles. Harness `--dsw-*` tokens keep light/dark themes consistent; literals are fallbacks only. */
export const STYLE = `
.dmb-root {
  position: absolute;
  right: 20px;
  bottom: 132px;
  z-index: 40;
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 8px;
  pointer-events: none;
  font-size: 12px;
  color: var(--dsw-alias-label-primary, #1f2329);
}
.dmb-root > * { pointer-events: auto; }
.dmb-pill {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  max-width: 280px;
  height: 28px;
  padding: 0 12px;
  border: 1px solid var(--dsw-alias-border-l3, rgba(0, 0, 0, 0.12));
  border-radius: 999px;
  background: var(--dsw-hovercard-bg, var(--dsw-alias-bg-layer-1, #fff));
  box-shadow: var(--dsw-shadow-lv3, 0 4px 16px rgba(0, 0, 0, 0.12));
  color: inherit;
  font: inherit;
  cursor: pointer;
}
.dmb-pill:hover { background: var(--dsw-alias-interactive-bg-hover, rgba(0, 0, 0, 0.04)); }
.dmb-pill:focus-visible, .dmb-tab:focus-visible, .dmb-field select:focus-visible {
  outline: var(--dsw-focus-ring-width, 2px) solid var(--dsw-focus-ring-color, #4d6bfe);
  outline-offset: 1px;
}
.dmb-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--dsw-alias-label-tertiary, #a0a4ab);
  flex: none;
}
.dmb-pill-on .dmb-dot { background: var(--dsw-alias-brand-primary, #4d6bfe); }
.dmb-sep { opacity: 0.5; }
.dmb-summary { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; opacity: 0.85; }
.dmb-spin {
  width: 10px;
  height: 10px;
  border: 2px solid currentColor;
  border-right-color: transparent;
  border-radius: 50%;
  animation: dmb-spin 0.8s linear infinite;
  flex: none;
}
@keyframes dmb-spin { to { transform: rotate(360deg); } }
.dmb-panel {
  width: 280px;
  padding: 12px;
  display: flex;
  flex-direction: column;
  gap: 10px;
  max-height: calc(100vh - 220px);
  overflow-y: auto;
  border: 1px solid var(--dsw-alias-border-l3, rgba(0, 0, 0, 0.12));
  border-radius: var(--dsw-radius-lg, 12px);
  background: var(--dsw-hovercard-bg, var(--dsw-alias-bg-layer-1, #fff));
  box-shadow: var(--dsw-elevation-panel, var(--dsw-shadow-lv3, 0 8px 24px rgba(0, 0, 0, 0.16)));
}
.dmb-row { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.dmb-title { font-weight: 600; font-size: 13px; }
.dmb-switch, .dmb-check { display: inline-flex; align-items: center; gap: 6px; cursor: pointer; }
.dmb-switch input, .dmb-check input {
  appearance: none;
  position: relative;
  width: 30px;
  height: 18px;
  flex: none;
  margin: 0;
  border: 0;
  border-radius: 999px;
  background: var(--dsw-alias-label-tertiary, #a0a4ab);
  cursor: pointer;
  transition: background 120ms ease;
}
.dmb-switch input::before, .dmb-check input::before {
  content: '';
  position: absolute;
  top: 2px;
  left: 2px;
  width: 14px;
  height: 14px;
  border-radius: 50%;
  background: #fff;
  box-shadow: 0 1px 2px rgba(0, 0, 0, 0.15);
  transition: transform 120ms ease;
}
.dmb-switch input:checked, .dmb-check input:checked { background: var(--dsw-alias-brand-primary, #4d6bfe); }
.dmb-switch input:checked::before, .dmb-check input:checked::before { transform: translateX(12px); }
.dmb-switch input:disabled, .dmb-check input:disabled { opacity: 0.45; cursor: default; }
.dmb-switch input:focus-visible, .dmb-check input:focus-visible {
  outline: var(--dsw-focus-ring-width, 2px) solid var(--dsw-focus-ring-color, #4d6bfe);
  outline-offset: 2px;
}
@media (prefers-reduced-motion: reduce) {
  .dmb-switch input, .dmb-check input, .dmb-switch input::before, .dmb-check input::before { transition: none; }
}
.dmb-tabs {
  display: grid;
  grid-template-columns: 1fr 1fr;
  padding: 2px;
  border-radius: var(--dsw-radius-md, 8px);
  background: var(--dsw-alias-interactive-bg-hover, rgba(0, 0, 0, 0.05));
}
.dmb-tab {
  height: 26px;
  border: 0;
  border-radius: var(--dsw-radius-sm, 6px);
  background: transparent;
  color: inherit;
  font: inherit;
  cursor: pointer;
}
.dmb-tab-on {
  background: var(--dsw-hovercard-bg, var(--dsw-alias-bg-layer-1, #fff));
  box-shadow: 0 1px 2px rgba(0, 0, 0, 0.12);
  font-weight: 600;
}
.dmb-field { display: flex; flex-direction: column; gap: 4px; }
.dmb-field > span { opacity: 0.7; }
.dmb-field select {
  height: 28px;
  padding: 0 6px;
  border: 1px solid var(--dsw-alias-border-l3, rgba(0, 0, 0, 0.12));
  border-radius: var(--dsw-radius-sm, 6px);
  background: transparent;
  color: inherit;
  font: inherit;
}
.dmb-field select option, .dmb-field select optgroup {
  background: var(--dsw-hovercard-bg, var(--dsw-alias-bg-layer-1, #fff));
  color: var(--dsw-alias-label-primary, #1f2329);
}
.dmb-note { margin: -4px 0 0; opacity: 0.6; }
.dmb-error {
  padding: 6px 8px;
  border-radius: var(--dsw-radius-sm, 6px);
  background: rgba(240, 68, 56, 0.1);
  color: var(--dsw-alias-state-danger, #d93026);
  word-break: break-word;
}
.dmb-link {
  margin-left: 6px;
  padding: 0;
  border: 0;
  background: none;
  color: var(--dsw-alias-link, #4d6bfe);
  font: inherit;
  cursor: pointer;
}
.dmb-section {
  border-top: 1px solid var(--dsw-alias-border-l3, rgba(0, 0, 0, 0.12));
  padding-top: 8px;
}
.dmb-section-head {
  width: 100%;
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 2px 0;
  border: 0;
  background: none;
  color: inherit;
  font: inherit;
  font-weight: 600;
  cursor: pointer;
}
.dmb-section-body { display: flex; flex-direction: column; gap: 8px; margin-top: 8px; }
.dmb-inline { flex-direction: row; align-items: center; flex-wrap: wrap; gap: 4px; }
.dmb-inline > span { opacity: 0.8; }
.dmb-divider { height: 1px; background: var(--dsw-alias-border-l3, rgba(0, 0, 0, 0.12)); }
.dmb-num, .dmb-row select {
  height: 28px;
  padding: 0 6px;
  border: 1px solid var(--dsw-alias-border-l3, rgba(0, 0, 0, 0.12));
  border-radius: var(--dsw-radius-sm, 6px);
  background: transparent;
  color: inherit;
  font: inherit;
}
.dmb-num { width: 72px; }
.dmb-inline .dmb-num { width: 52px; }
.dmb-grow { flex: 1; min-width: 0; }
.dmb-preview {
  padding: 6px 8px;
  border-radius: var(--dsw-radius-sm, 6px);
  background: var(--dsw-alias-interactive-bg-hover, rgba(0, 0, 0, 0.05));
}
.dmb-preview-row { opacity: 0.75; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dmb-btn {
  flex: 1;
  height: 28px;
  border: 1px solid var(--dsw-alias-border-l3, rgba(0, 0, 0, 0.12));
  border-radius: var(--dsw-radius-sm, 6px);
  background: transparent;
  color: inherit;
  font: inherit;
  cursor: pointer;
}
.dmb-btn:disabled { opacity: 0.5; cursor: default; }
.dmb-btn-primary {
  border-color: transparent;
  background: var(--dsw-alias-button-primary-fill, #4d6bfe);
  color: var(--dsw-alias-label-primary-foreground, #fff);
}
.dmb-btn-danger {
  border-color: transparent;
  background: var(--dsw-alias-state-danger, #d93026);
  color: #fff;
}
`
