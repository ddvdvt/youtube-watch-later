// Styles of the in-page UI (inside shadow roots). Colours follow YouTube's own theme
// (html[dark] is set by YouTube in dark mode).
export const BASE_CSS = `
:host{all:initial;--bg:#ffffff;--bg2:#f2f2f2;--fg:#0f0f0f;--fg2:#606060;--line:#d9d9d9;--accent:#0f7c6c;--accent-fg:#fff;--accent-soft:#dff3ef;--danger:#b3261e;--danger-soft:#fde7e5;--warn:#8a5300;--warn-soft:#fff2d6;--focus:#1a73e8;font:14px/1.4 Roboto,"Segoe UI",system-ui,Arial,sans-serif;color:var(--fg)}
:host-context(html[dark]){--bg:#212121;--bg2:#2c2c2c;--fg:#f1f1f1;--fg2:#aaaaaa;--line:#3f3f3f;--accent:#5fd0bc;--accent-fg:#06201b;--accent-soft:#1d3833;--danger:#ff8a80;--danger-soft:#3b1d1b;--warn:#f0c060;--warn-soft:#3a3020;--focus:#8ab4f8}
*{box-sizing:border-box}
.hidden{display:none!important}
button,input,select{font:inherit;color:inherit}
button{cursor:pointer}
:focus-visible{outline:2px solid var(--focus);outline-offset:1px}
.btn{display:inline-flex;align-items:center;justify-content:center;gap:6px;min-height:32px;padding:5px 12px;border:1px solid var(--line);border-radius:18px;background:var(--bg2);white-space:nowrap}
.btn:hover{border-color:var(--accent)}
.btn:disabled{opacity:.5;cursor:default}
.btn.primary{background:var(--accent);border-color:var(--accent);color:var(--accent-fg)}
.btn.danger{background:var(--danger);border-color:var(--danger);color:#fff}
:host-context(html[dark]) .btn.danger{color:#1b0b0a}
.btn.small{min-height:26px;padding:2px 9px;font-size:12.5px}
.btn.icon{min-height:26px;width:26px;padding:0;border-radius:50%}
.muted{color:var(--fg2)}
input[type=number],input[type=text],input[type=search],select{background:var(--bg);border:1px solid var(--line);border-radius:6px;padding:4px 7px;min-height:30px}
input[type=checkbox]{accent-color:var(--accent);width:16px;height:16px;margin:0}
`;
