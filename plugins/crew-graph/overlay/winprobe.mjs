// What Windows itself says about the pet's window, for the input diagnostics (docs/guide.md, Desktop pet). Read only: it asks the OS about
// windows (style bits, visibility, cloaking, z-order, which window is at a point) and never sends input or shows anything.
// Electron has no API for these and they decide the question "do the clicks fall through the pet, or does it swallow them?": WS_EX_TRANSPARENT
// is what click-through is on Windows, and WindowFromPoint skips a window that is transparent to the mouse.
//
// OPT-IN: overlay/main.js runs this only for the tray item "Save input diagnostics", or for every dump when CREW_PET_WINPROBE=1 is set. Nothing
// is written or compiled at start. The PowerShell script is written to a file when first used (scriptText), not passed as an -EncodedCommand
// (that is what security software looks at), and compiles the helper in memory in the same call, which takes a few seconds: nothing waits for it.
// hwnd: the window handle as a number; points: [{ x, y }] in physical pixels to ask "which window is here". The
// output is lines of text and goes into the diagnostics file as it is. Window titles are left out on purpose: the file gets sent to someone.

import { createHash } from 'node:crypto'

const CS = `
using System; using System.Text; using System.Runtime.InteropServices;
public static class CrewWin {
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X, Y; }
  [DllImport("user32.dll")] static extern bool SetProcessDpiAwarenessContext(IntPtr c);
  [DllImport("user32.dll")] static extern int GetWindowLongW(IntPtr h, int i);
  [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] static extern IntPtr GetWindow(IntPtr h, uint c);
  [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] static extern IntPtr WindowFromPoint(POINT p);
  [DllImport("user32.dll")] static extern IntPtr GetAncestor(IntPtr h, uint f);
  [DllImport("user32.dll")] static extern bool GetCursorPos(out POINT p);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassNameW(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("dwmapi.dll")] static extern int DwmGetWindowAttribute(IntPtr h, int a, out int v, int n);

  static string Flags(int ex) {
    string s = "";
    if ((ex & 0x8) != 0) s += " TOPMOST";
    if ((ex & 0x20) != 0) s += " TRANSPARENT";
    if ((ex & 0x80000) != 0) s += " LAYERED";
    if ((ex & 0x8000000) != 0) s += " NOACTIVATE";
    if ((ex & 0x80) != 0) s += " TOOLWINDOW";
    return s.Length == 0 ? " (none)" : s;
  }
  static int Cloaked(IntPtr h) { int v; return DwmGetWindowAttribute(h, 14, out v, 4) == 0 ? v : -1; }
  static string Desc(IntPtr h) {
    if (h == IntPtr.Zero) return "(none)";
    var c = new StringBuilder(80); GetClassNameW(h, c, 80);
    uint pid; GetWindowThreadProcessId(h, out pid);
    RECT r; GetWindowRect(h, out r);
    return "0x" + h.ToInt64().ToString("x") + " class=" + c + " pid=" + pid + " rect=" + r.L + "," + r.T + "," + r.R + "," + r.B;
  }
  // rect: where the pet's window was when the dump began (left, top, right, bottom), because a fold may have shrunk it by the time this runs
  public static string Probe(long hwnd, int[] pts, int[] rect) {
    try { SetProcessDpiAwarenessContext(new IntPtr(-4)); } catch { }
    var o = new StringBuilder();
    IntPtr pet = new IntPtr(hwnd);
    RECT pr; GetWindowRect(pet, out pr);
    RECT was = pr;
    if (rect != null && rect.Length == 4 && rect[2] > rect[0]) { was.L = rect[0]; was.T = rect[1]; was.R = rect[2]; was.B = rect[3]; }
    int ex = GetWindowLongW(pet, -20);
    o.AppendLine("pet window: " + Desc(pet));
    o.AppendLine("pet visible=" + IsWindowVisible(pet) + " iconic=" + IsIconic(pet) + " cloaked=" + Cloaked(pet) + " exstyle=0x" + ex.ToString("x") + Flags(ex));
    POINT cp; GetCursorPos(out cp);
    o.AppendLine("cursor now: " + cp.X + "," + cp.Y);
    o.AppendLine("foreground: " + Desc(GetForegroundWindow()));
    for (int i = 0; i + 1 < pts.Length; i += 2) {
      POINT p; p.X = pts[i]; p.Y = pts[i + 1];
      IntPtr hit = WindowFromPoint(p);
      IntPtr root = hit == IntPtr.Zero ? hit : GetAncestor(hit, 2);
      o.AppendLine("window at " + p.X + "," + p.Y + ": " + (root == pet ? "THE PET" : "not the pet") + " <- " + Desc(root));
    }
    o.AppendLine("pet rectangle when the dump began: " + was.L + "," + was.T + "," + was.R + "," + was.B + " (now " + pr.L + "," + pr.T + "," + pr.R + "," + pr.B + ")");
    o.AppendLine("windows above the pet in z-order that overlap that rectangle (visible, not cloaked, nearest first, up to 12):");
    int n = 0, seen = 0;
    for (IntPtr h = GetWindow(pet, 3); h != IntPtr.Zero && seen < 3000 && n < 12; h = GetWindow(h, 3), seen++) {
      if (!IsWindowVisible(h) || IsIconic(h) || Cloaked(h) > 0) continue;
      RECT r; GetWindowRect(h, out r);
      if (r.R <= r.L || r.B <= r.T) continue;
      if (r.R <= was.L || r.L >= was.R || r.B <= was.T || r.T >= was.B) continue;
      int hx = GetWindowLongW(h, -20);
      o.AppendLine("  " + Desc(h) + " exstyle=0x" + hx.ToString("x") + Flags(hx));
      n++;
    }
    if (n == 0) o.AppendLine("  (none)");
    return o.ToString();
  }
}
`

/** A short hash of the helper's source and script: part of the names of the files it is kept in. */
export const sourceHash = () => createHash('sha256').update(CS).update(PS).digest('hex').slice(0, 8)

const PS = `param([long]$Hwnd = 0, [string]$Points = '', [string]$Rect = '')
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$src = @'
${CS}
'@
Add-Type -TypeDefinition $src
[CrewWin]::Probe($Hwnd, [int[]]($Points -split ','), [int[]]($Rect -split ','))
`

/** The text of the PowerShell script (written to a file by the caller). */
export const scriptText = () => PS

const BASE = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File']

/** execFile arguments that print the probe for window `hwnd`, the points in `points` ([{ x, y }], physical pixels) and the window's rectangle `rect` ({ left, top, right, bottom }) as it was. */
export function probeArgs(script, hwnd, points, rect) {
  const h = Math.trunc(Number(hwnd))
  if (!Number.isSafeInteger(h) || h <= 0) throw new Error('not a window handle')
  const pts = (Array.isArray(points) ? points : []).slice(0, 8).flatMap(p => [Math.round(Number(p.x)) || 0, Math.round(Number(p.y)) || 0])
  return { file: 'powershell.exe', args: [...BASE, script, '-Hwnd', String(h), '-Points', pts.length ? pts.join(',') : '0,0', '-Rect', rect ? [rect.left, rect.top, rect.right, rect.bottom].map(n => Math.round(Number(n)) || 0).join(',') : '0,0,0,0'] }
}
