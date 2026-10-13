// ZoomCapture floating controls for Windows: a small always-on-top window with the recording
// timer and Pause / Resume, Mute and Stop buttons, which Windows leaves out of screen captures
// (SetWindowDisplayAffinity with WDA_EXCLUDEFROMCAPTURE, Windows 10 version 2004 or later).
//
// It is a Chrome native messaging host: Chrome starts it when the extension connects and stops it
// when the connection closes. Messages are JSON, each preceded by its length (4 bytes, little
// endian), on stdin (from the extension) and stdout (to the extension).
//
//   extension → helper: { type: "show" | "state", phase: "countdown" | "recording" | "paused",
//                         countdown, elapsedMs, micAvailable, micMuted }, { type: "hide" },
//                         { type: "camera", frame: <JPEG, base64> | null }, { type: "ping" }
//   helper → extension: { type: "ready", version, excluded }, { type: "pong", version, excluded },
//                       { type: "command", action: "pause" | "resume" | "stop" | "toggleMic" | "cancel" }
//
// Built with the C# compiler that ships with Windows (.NET Framework 4); see install.ps1.
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;
using System.Windows.Forms;

namespace ZoomCapture
{
    static class Program
    {
        public const string Version = "1.2.0";

        [STAThread]
        static int Main(string[] args)
        {
            if (args.Length > 0 && args[0] == "--version")
            {
                Console.WriteLine(Version);
                return 0;
            }
            // Diagnostics only (tests compare against it): leave the window visible to screen capture.
            ControlsForm.IncludeInCapture = Array.IndexOf(args, "--include-in-capture") >= 0;
            Native.EnableDpiAwareness();
            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);

            var context = new ApplicationContext();
            var form = new ControlsForm();
            // The window exists (so it can be excluded from capture) but stays hidden until "show".
            var unused = form.Handle;
            var host = new Host(form, context);
            form.Host = host;
            host.Start();
            Application.Run(context);
            return 0;
        }
    }

    static class Native
    {
        public const uint WDA_NONE = 0x0;
        public const uint WDA_EXCLUDEFROMCAPTURE = 0x11;
        public const int WM_NCLBUTTONDOWN = 0xA1;
        public const int HTCAPTION = 0x2;
        public const int WM_MOUSEACTIVATE = 0x21;
        public const int MA_NOACTIVATE = 3;
        public const int WM_EXITSIZEMOVE = 0x232;
        public const int WS_EX_TOOLWINDOW = 0x80;
        public const int WS_EX_TOPMOST = 0x8;
        public const int WS_EX_NOACTIVATE = 0x08000000;

        [DllImport("user32.dll", SetLastError = true)]
        public static extern bool SetWindowDisplayAffinity(IntPtr hwnd, uint affinity);

        [DllImport("user32.dll", SetLastError = true)]
        public static extern bool GetWindowDisplayAffinity(IntPtr hwnd, out uint affinity);

        [DllImport("user32.dll")]
        public static extern bool ReleaseCapture();

        [DllImport("user32.dll")]
        public static extern IntPtr SendMessage(IntPtr hwnd, int msg, IntPtr wParam, IntPtr lParam);

        [DllImport("user32.dll")]
        static extern bool SetProcessDPIAware();

        [DllImport("user32.dll")]
        static extern bool SetProcessDpiAwarenessContext(IntPtr value);

        public static void EnableDpiAwareness()
        {
            try
            {
                // Per-monitor v2: crisp on every display; sizes are scaled by hand (see Scale).
                if (SetProcessDpiAwarenessContext(new IntPtr(-4))) return;
            }
            catch (EntryPointNotFoundException) { }
            try { SetProcessDPIAware(); } catch (EntryPointNotFoundException) { }
        }
    }

    /// <summary>Reads and writes Chrome native messages; runs the UI commands on the window's thread.</summary>
    sealed class Host
    {
        readonly ControlsForm form;
        readonly ApplicationContext context;
        readonly Stream input = Console.OpenStandardInput();
        readonly Stream output = Console.OpenStandardOutput();
        readonly object writeLock = new object();
        // Camera frames are a few tens of kilobytes of base64.
        readonly JavaScriptSerializer json = new JavaScriptSerializer { MaxJsonLength = 8 * 1024 * 1024 };

        public Host(ControlsForm form, ApplicationContext context)
        {
            this.form = form;
            this.context = context;
        }

        public void Start()
        {
            var reader = new Thread(ReadLoop) { IsBackground = true, Name = "native-messaging" };
            reader.Start();
            Send(new Dictionary<string, object> { { "type", "ready" }, { "version", Program.Version }, { "excluded", form.ExcludedFromCapture } });
        }

        void ReadLoop()
        {
            try
            {
                while (true)
                {
                    var header = ReadExactly(4);
                    if (header == null) break;
                    var length = BitConverter.ToInt32(header, 0);
                    if (length <= 0 || length > 1024 * 1024) break;
                    var body = ReadExactly(length);
                    if (body == null) break;
                    var message = json.Deserialize<Dictionary<string, object>>(Encoding.UTF8.GetString(body));
                    form.BeginInvoke(new Action(() => Handle(message)));
                }
            }
            catch (Exception)
            {
                // The extension went away or sent something unreadable: close.
            }
            // Chrome closed the connection (the studio stopped or closed): quit.
            try { form.BeginInvoke(new Action(() => { form.Close(); context.ExitThread(); })); }
            catch (InvalidOperationException) { Environment.Exit(0); }
        }

        byte[] ReadExactly(int count)
        {
            var buffer = new byte[count];
            var offset = 0;
            while (offset < count)
            {
                var read = input.Read(buffer, offset, count - offset);
                if (read <= 0) return null;
                offset += read;
            }
            return buffer;
        }

        void Handle(Dictionary<string, object> message)
        {
            object type;
            if (message == null || !message.TryGetValue("type", out type)) return;
            switch (type as string)
            {
                case "show":
                    form.ApplyState(message);
                    form.ShowControls();
                    break;
                case "state":
                    form.ApplyState(message);
                    break;
                case "hide":
                    form.Hide();
                    break;
                case "camera":
                    object frame;
                    message.TryGetValue("frame", out frame);
                    form.SetCamera(frame as string);
                    break;
                case "ping":
                    Send(new Dictionary<string, object> { { "type", "pong" }, { "version", Program.Version }, { "excluded", form.ExcludedFromCapture } });
                    break;
            }
        }

        public void Send(Dictionary<string, object> message)
        {
            var bytes = Encoding.UTF8.GetBytes(json.Serialize(message));
            lock (writeLock)
            {
                try
                {
                    output.Write(BitConverter.GetBytes(bytes.Length), 0, 4);
                    output.Write(bytes, 0, bytes.Length);
                    output.Flush();
                }
                catch (IOException)
                {
                    // Chrome is gone; the reader thread ends the process.
                }
            }
        }

        public void Command(string action)
        {
            Send(new Dictionary<string, object> { { "type", "command" }, { "action", action } });
        }
    }

    enum Glyph { Microphone, MicrophoneOff, Pause, Resume, Stop, Cancel }

    /// <summary>
    /// A flat icon button drawn to match the extension's style. A plain control (not a Win32
    /// button) so its accessibility object is used: screen readers and UI Automation see a named
    /// push button that can be pressed.
    /// </summary>
    sealed class GlyphButton : Control
    {
        Glyph glyph;
        bool hover;
        public bool Danger;

        public GlyphButton()
        {
            SetStyle(ControlStyles.UserPaint | ControlStyles.AllPaintingInWmPaint | ControlStyles.OptimizedDoubleBuffer, true);
            SetStyle(ControlStyles.Selectable, false);
            // Every press is a click (quick presses are not turned into a double-click).
            SetStyle(ControlStyles.StandardClick, true);
            SetStyle(ControlStyles.StandardDoubleClick, false);
            TabStop = false;
            Cursor = Cursors.Hand;
            AccessibleRole = AccessibleRole.PushButton;
        }

        public void PerformClick() { OnClick(EventArgs.Empty); }

        /// <summary>Name for screen readers and tooltips.</summary>
        public string Label
        {
            get { return AccessibleName; }
            set { AccessibleName = value; Text = value; }
        }

        public Glyph Glyph
        {
            get { return glyph; }
            set { glyph = value; Invalidate(); }
        }

        // A named push button for screen readers and UI Automation (custom painting hides it otherwise).
        protected override AccessibleObject CreateAccessibilityInstance() { return new GlyphAccessible(this); }

        sealed class GlyphAccessible : ControlAccessibleObject
        {
            readonly GlyphButton owner;
            public GlyphAccessible(GlyphButton owner) : base(owner) { this.owner = owner; }
            public override AccessibleRole Role { get { return AccessibleRole.PushButton; } }
            public override string Name { get { return owner.AccessibleName; } set { owner.AccessibleName = value; } }
            public override string DefaultAction { get { return "Press"; } }
            public override void DoDefaultAction() { owner.PerformClick(); }
        }

        protected override void OnMouseEnter(EventArgs e) { hover = true; Invalidate(); base.OnMouseEnter(e); }
        protected override void OnMouseLeave(EventArgs e) { hover = false; Invalidate(); base.OnMouseLeave(e); }

        protected override void OnPaint(PaintEventArgs e)
        {
            var g = e.Graphics;
            g.SmoothingMode = SmoothingMode.AntiAlias;
            g.Clear(Parent.BackColor);
            var bounds = new RectangleF(0, 0, Width - 1, Height - 1);
            if (Danger || hover)
            {
                var fill = Danger ? Color.FromArgb(hover ? 70 : 40, 255, 77, 94) : Color.FromArgb(30, 41, 48);
                using (var path = Theme.Rounded(bounds, Width * 0.28f)) using (var brush = new SolidBrush(fill)) g.FillPath(brush, path);
            }
            var color = Danger ? Theme.Rec : (glyph == Glyph.MicrophoneOff ? Theme.Rec : (hover ? Theme.Fg : Theme.FgMuted));
            float s = Width / 28f;
            float cx = Width / 2f, cy = Height / 2f;
            using (var pen = new Pen(color, 1.6f * s) { StartCap = LineCap.Round, EndCap = LineCap.Round, LineJoin = LineJoin.Round })
            using (var brush = new SolidBrush(color))
            {
                switch (glyph)
                {
                    case Glyph.Pause:
                        g.FillRectangle(brush, cx - 4.5f * s, cy - 5.5f * s, 3f * s, 11f * s);
                        g.FillRectangle(brush, cx + 1.5f * s, cy - 5.5f * s, 3f * s, 11f * s);
                        break;
                    case Glyph.Resume:
                        g.FillPolygon(brush, new[] { new PointF(cx - 3.5f * s, cy - 6 * s), new PointF(cx + 6 * s, cy), new PointF(cx - 3.5f * s, cy + 6 * s) });
                        break;
                    case Glyph.Stop:
                        using (var path = Theme.Rounded(new RectangleF(cx - 5 * s, cy - 5 * s, 10 * s, 10 * s), 2 * s)) g.DrawPath(pen, path);
                        break;
                    case Glyph.Cancel:
                        g.DrawLine(pen, cx - 4.5f * s, cy - 4.5f * s, cx + 4.5f * s, cy + 4.5f * s);
                        g.DrawLine(pen, cx + 4.5f * s, cy - 4.5f * s, cx - 4.5f * s, cy + 4.5f * s);
                        break;
                    default:
                        using (var path = Theme.Rounded(new RectangleF(cx - 2.8f * s, cy - 7 * s, 5.6f * s, 9 * s), 2.8f * s)) g.DrawPath(pen, path);
                        g.DrawArc(pen, cx - 5.5f * s, cy - 4 * s, 11 * s, 9.5f * s, 0, 180);
                        g.DrawLine(pen, cx, cy + 5.5f * s, cx, cy + 7.5f * s);
                        if (glyph == Glyph.MicrophoneOff) g.DrawLine(pen, cx - 6 * s, cy - 7 * s, cx + 6 * s, cy + 7 * s);
                        break;
                }
            }
        }
    }

    static class Theme
    {
        public static readonly Color Surface = Color.FromArgb(15, 17, 24);
        public static readonly Color Line = Color.FromArgb(54, 60, 80);
        public static readonly Color Fg = Color.FromArgb(236, 238, 244);
        public static readonly Color FgMuted = Color.FromArgb(163, 169, 187);
        public static readonly Color Rec = Color.FromArgb(255, 77, 94);
        public static readonly Color Warning = Color.FromArgb(251, 191, 36);

        public static GraphicsPath Rounded(RectangleF r, float radius)
        {
            var d = Math.Min(radius * 2, Math.Min(r.Width, r.Height));
            var path = new GraphicsPath();
            path.AddArc(r.X, r.Y, d, d, 180, 90);
            path.AddArc(r.Right - d, r.Y, d, d, 270, 90);
            path.AddArc(r.Right - d, r.Bottom - d, d, d, 0, 90);
            path.AddArc(r.X, r.Bottom - d, d, d, 90, 90);
            path.CloseFigure();
            return path;
        }
    }

    /// <summary>
    /// The floating controls: the camera preview in a circle (when the camera is on), above a bar
    /// with the timer, then Mute, Pause/Resume and Stop. Drag anywhere else to move it.
    /// </summary>
    sealed class ControlsForm : Form
    {
        public Host Host;
        public static bool IncludeInCapture;
        public bool ExcludedFromCapture { get; private set; }

        readonly GlyphButton mic = new GlyphButton();
        readonly GlyphButton pause = new GlyphButton();
        readonly GlyphButton stop = new GlyphButton { Danger = true, Glyph = Glyph.Stop };
        readonly ToolTip tips = new ToolTip();
        readonly System.Windows.Forms.Timer ticker = new System.Windows.Forms.Timer { Interval = 250 };
        readonly Stopwatch sinceState = new Stopwatch();
        readonly Font timeFont;
        string phase = "recording";
        int countdown;
        double elapsedMs;
        bool micAvailable;
        bool micMuted;
        float scale = 1f;
        /// <summary>Latest camera frame (already mirrored and square), or null without a camera.</summary>
        Image camera;
        const float CameraSize = 168, CameraGap = 8, BarHeight = 40;

        public ControlsForm()
        {
            Text = "ZoomCapture controls";
            FormBorderStyle = FormBorderStyle.None;
            ShowInTaskbar = false;
            TopMost = true;
            StartPosition = FormStartPosition.Manual;
            BackColor = Theme.Surface;
            DoubleBuffered = true;
            AccessibleName = "ZoomCapture recording controls";
            timeFont = new Font("Consolas", 10.5f, FontStyle.Bold);

            mic.Click += delegate { Host.Command("toggleMic"); };
            pause.Click += delegate { Host.Command(phase == "paused" ? "resume" : "pause"); };
            stop.Click += delegate { Host.Command(phase == "countdown" ? "cancel" : "stop"); };
            stop.Label = "Stop recording";
            Controls.Add(mic);
            Controls.Add(pause);
            Controls.Add(stop);
            tips.SetToolTip(stop, "Stop recording");

            ticker.Tick += delegate { Invalidate(TimeArea()); };
        }

        protected override bool ShowWithoutActivation { get { return true; } }

        protected override CreateParams CreateParams
        {
            get
            {
                var cp = base.CreateParams;
                // Not in the taskbar or Alt+Tab, always on top, and clicking it never steals focus
                // from the app being recorded.
                cp.ExStyle |= Native.WS_EX_TOOLWINDOW | Native.WS_EX_TOPMOST | Native.WS_EX_NOACTIVATE;
                return cp;
            }
        }

        protected override void OnHandleCreated(EventArgs e)
        {
            base.OnHandleCreated(e);
            uint affinity;
            ExcludedFromCapture = !IncludeInCapture
                && Native.SetWindowDisplayAffinity(Handle, Native.WDA_EXCLUDEFROMCAPTURE)
                && Native.GetWindowDisplayAffinity(Handle, out affinity) && affinity == Native.WDA_EXCLUDEFROMCAPTURE;
            using (var g = CreateGraphics()) scale = g.DpiX / 96f;
            Relayout();
            Location = RestorePosition();
        }

        protected override void WndProc(ref Message m)
        {
            if (m.Msg == Native.WM_MOUSEACTIVATE)
            {
                m.Result = new IntPtr(Native.MA_NOACTIVATE);
                return;
            }
            base.WndProc(ref m);
            if (m.Msg == Native.WM_EXITSIZEMOVE) SavePosition();
        }

        protected override void OnDpiChanged(DpiChangedEventArgs e)
        {
            base.OnDpiChanged(e);
            scale = e.DeviceDpiNew / 96f;
            Relayout();
        }

        public void ApplyState(Dictionary<string, object> message)
        {
            object value;
            if (message.TryGetValue("phase", out value) && value is string) phase = (string)value;
            if (message.TryGetValue("elapsedMs", out value) && value != null) elapsedMs = Convert.ToDouble(value);
            if (message.TryGetValue("countdown", out value) && value != null) countdown = Convert.ToInt32(value);
            if (message.TryGetValue("micAvailable", out value) && value is bool) micAvailable = (bool)value;
            if (message.TryGetValue("micMuted", out value) && value is bool) micMuted = (bool)value;
            sinceState.Restart();
            mic.Glyph = micMuted ? Glyph.MicrophoneOff : Glyph.Microphone;
            mic.Label = micMuted ? "Unmute microphone" : "Mute microphone";
            tips.SetToolTip(mic, mic.Label);
            pause.Glyph = phase == "paused" ? Glyph.Resume : Glyph.Pause;
            pause.Label = phase == "paused" ? "Resume recording" : "Pause recording";
            tips.SetToolTip(pause, pause.Label);
            // Counting down: only a Cancel button.
            stop.Glyph = phase == "countdown" ? Glyph.Cancel : Glyph.Stop;
            stop.Danger = phase != "countdown";
            stop.Label = phase == "countdown" ? "Cancel recording" : "Stop recording";
            tips.SetToolTip(stop, stop.Label);
            Relayout();
            Invalidate();
        }

        /// <summary>Shows a camera frame (JPEG, base64) in the circle; null removes the circle.</summary>
        public void SetCamera(string jpegBase64)
        {
            Image next = null;
            if (!string.IsNullOrEmpty(jpegBase64))
            {
                try
                {
                    using (var stream = new MemoryStream(Convert.FromBase64String(jpegBase64)))
                    using (var decoded = Image.FromStream(stream))
                        next = new Bitmap(decoded);
                }
                catch (Exception)
                {
                    return; // A bad frame: keep the last one.
                }
            }
            var layoutChanged = (camera == null) != (next == null);
            if (camera != null) camera.Dispose();
            camera = next;
            if (layoutChanged)
            {
                Relayout();
                Invalidate();
            }
            else if (camera != null)
            {
                Invalidate(CameraArea);
            }
        }

        public void ShowControls()
        {
            if (!Visible) Show();
            ticker.Start();
        }

        int S(float dip) { return (int)Math.Round(dip * scale); }

        Rectangle TimeArea() { return new Rectangle(BarLeft + S(8), BarTop, S(TextWidth + 22), S(BarHeight)); }

        /// <summary>Top of the controls bar (below the camera circle, if any), in pixels.</summary>
        int BarTop { get { return camera != null ? S(CameraSize + CameraGap) : 0; } }
        int barWidth;
        int BarLeft { get { return (Width - barWidth) / 2; } }
        Rectangle CameraArea { get { return new Rectangle((Width - S(CameraSize)) / 2, 0, S(CameraSize), S(CameraSize)); } }

        bool Counting { get { return phase == "countdown"; } }

        /** Width of the time or countdown text, in DIPs. */
        float TextWidth { get { return Counting ? 80 : 52; } }

        void Relayout()
        {
            const float button = 28, gap = 2;
            float x = 28 + TextWidth;
            float bar = x + (micAvailable && !Counting ? button + gap : 0) + (Counting ? 0 : button + gap) + button + 4;
            barWidth = S(bar);
            var width = Math.Max(barWidth, camera != null ? S(CameraSize) : 0);
            var left = (width - barWidth) / 2;
            var micShown = micAvailable && !Counting;
            mic.Visible = micShown;
            pause.Visible = !Counting;
            foreach (var b in new[] { mic, pause, stop })
            {
                // (Not b.Visible: it reads false for every control until the window is shown.)
                if ((b == mic && !micShown) || (b == pause && Counting)) continue;
                b.SetBounds(left + S(x), BarTop + S(6), S(button), S(button));
                x += button + gap;
            }
            var size = new Size(width, BarTop + S(BarHeight));
            if (Size != size)
            {
                // Grow and shrink around the bar: it stays where the user put it.
                var anchor = new Point(Left + Width / 2, Bottom);
                Size = size;
                if (anchor.Y > 0) Location = KeepOnScreen(new Point(anchor.X - Width / 2, anchor.Y - Height));
            }
            // Shaped window: the bar, plus the camera circle above it.
            using (var shape = Theme.Rounded(new RectangleF(left, BarTop, barWidth, S(BarHeight)), S(12)))
            {
                if (camera != null) shape.AddEllipse(CameraArea);
                Region = new Region(shape);
            }
        }

        protected override void OnPaint(PaintEventArgs e)
        {
            var g = e.Graphics;
            g.SmoothingMode = SmoothingMode.AntiAlias;
            g.TextRenderingHint = System.Drawing.Text.TextRenderingHint.ClearTypeGridFit;
            if (camera != null)
            {
                g.Clear(Theme.Surface);
                var area = CameraArea;
                using (var circle = new GraphicsPath())
                {
                    circle.AddEllipse(area);
                    var state = g.Save();
                    g.SetClip(circle);
                    g.InterpolationMode = InterpolationMode.HighQualityBicubic;
                    g.DrawImage(camera, area);
                    g.Restore(state);
                }
                using (var ring = new Pen(Color.FromArgb(204, 255, 255, 255), 2 * scale))
                    g.DrawEllipse(ring, area.X + scale, area.Y + scale, area.Width - 2 * scale, area.Height - 2 * scale);
            }
            var barTop = BarTop;
            using (var path = Theme.Rounded(new RectangleF(BarLeft + 0.5f, barTop + 0.5f, barWidth - 1.5f, S(BarHeight) - 1.5f), S(12)))
            using (var pen = new Pen(Theme.Line, Math.Max(1, scale)))
                g.DrawPath(pen, path);

            var recording = phase == "recording";
            var shown = recording ? elapsedMs + sinceState.Elapsed.TotalMilliseconds : elapsedMs;
            if (Counting) recording = false;
            // A gently pulsing red dot while recording, amber while paused.
            var alpha = recording ? (int)(170 + 85 * Math.Abs(Math.Sin(sinceState.Elapsed.TotalSeconds * 2.5))) : 255;
            using (var dot = new SolidBrush(Color.FromArgb(alpha, recording ? Theme.Rec : Theme.Warning)))
                g.FillEllipse(dot, BarLeft + S(13), barTop + S(BarHeight) / 2f - S(4), S(8), S(8));
            var total = (int)(shown / 1000);
            var text = Counting
                ? "Starts in " + Math.Max(0, countdown)
                : total >= 3600
                    ? string.Format("{0}:{1:00}:{2:00}", total / 3600, total / 60 % 60, total % 60)
                    : string.Format("{0:00}:{1:00}", total / 60, total % 60);
            TextRenderer.DrawText(g, text, timeFont, new Rectangle(BarLeft + S(26), barTop, S(TextWidth), S(BarHeight)), Theme.Fg,
                TextFormatFlags.VerticalCenter | TextFormatFlags.Left | TextFormatFlags.NoPadding);
        }

        protected override void OnMouseDown(MouseEventArgs e)
        {
            base.OnMouseDown(e);
            if (e.Button != MouseButtons.Left) return;
            // Drag from anywhere that isn't a button to move the window.
            Native.ReleaseCapture();
            Native.SendMessage(Handle, Native.WM_NCLBUTTONDOWN, new IntPtr(Native.HTCAPTION), IntPtr.Zero);
        }

        static string PositionFile
        {
            get { return Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "ZoomCapture", "controls-anchor.txt"); }
        }

        Point RestorePosition()
        {
            try
            {
                // Saved as the bar's bottom centre, so it means the same with or without the camera.
                var parts = File.ReadAllText(PositionFile).Split(',');
                var saved = new Point(int.Parse(parts[0]) - Width / 2, int.Parse(parts[1]) - Height);
                // Only if it is still on a screen (monitors may have changed).
                foreach (var screen in Screen.AllScreens)
                    if (screen.WorkingArea.IntersectsWith(new Rectangle(saved, Size))) return saved;
            }
            catch (Exception) { }
            var area = Screen.PrimaryScreen.WorkingArea;
            return new Point(area.Left + (area.Width - Width) / 2, area.Bottom - Height - S(24));
        }

        /// <summary>Moves a position so the whole window is inside the working area of its screen.</summary>
        Point KeepOnScreen(Point location)
        {
            var area = Screen.FromRectangle(new Rectangle(location, Size)).WorkingArea;
            return new Point(
                Math.Max(area.Left, Math.Min(location.X, area.Right - Width)),
                Math.Max(area.Top, Math.Min(location.Y, area.Bottom - Height)));
        }

        void SavePosition()
        {
            try
            {
                Directory.CreateDirectory(Path.GetDirectoryName(PositionFile));
                File.WriteAllText(PositionFile, (Left + Width / 2) + "," + Bottom);
            }
            catch (Exception) { }
        }
    }
}
