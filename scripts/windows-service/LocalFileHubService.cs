// SCM wrapper for the Node.js application. The installer compiles this file
// with the .NET Framework compiler and stores its runtime paths in service.config.
using System;
using System.Diagnostics;
using System.IO;
using System.ServiceProcess;
using System.Text;
using System.Threading;

class LocalFileHubService : ServiceBase
{
    private Process _node;
    private volatile bool _stopping;
    private string _logDir = "";
    private readonly object _logLock = new object();

    public LocalFileHubService()
    {
        ServiceName = "LocalFileHub";
        CanStop = true;
        CanShutdown = true;
        AutoLog = true;
    }

    protected override void OnStart(string[] args)
    {
        try
        {
            string exeDir = AppDomain.CurrentDomain.BaseDirectory;
            string configPath = Path.Combine(exeDir, "service.config");
            string nodeExe = null, runner = null, root = null;

            if (!File.Exists(configPath))
                throw new FileNotFoundException("Missing service.config", configPath);

            foreach (string raw in File.ReadAllLines(configPath, Encoding.UTF8))
            {
                string line = raw.Trim();
                if (line.Length == 0 || line.StartsWith("#")) continue;
                int eq = line.IndexOf('=');
                if (eq <= 0) continue;
                string key = line.Substring(0, eq).Trim();
                string value = line.Substring(eq + 1).Trim();
                if (key == "node") nodeExe = value;
                else if (key == "runner") runner = value;
                else if (key == "root") root = value;
            }

            if (String.IsNullOrWhiteSpace(nodeExe) || !File.Exists(nodeExe))
                throw new FileNotFoundException("node.exe is missing or invalid", nodeExe);
            if (String.IsNullOrWhiteSpace(runner) || !File.Exists(runner))
                throw new FileNotFoundException("service-runner.mjs is missing or invalid", runner);
            if (String.IsNullOrWhiteSpace(root) || !Directory.Exists(root))
                throw new DirectoryNotFoundException("Project root is missing or invalid: " + root);

            _logDir = Path.Combine(root, "logs");
            Directory.CreateDirectory(_logDir);
            _stopping = false;

            var psi = new ProcessStartInfo();
            psi.FileName = nodeExe;
            psi.Arguments = QuoteArgument(runner);
            psi.WorkingDirectory = root;
            psi.UseShellExecute = false;
            psi.CreateNoWindow = true;
            psi.RedirectStandardOutput = true;
            psi.RedirectStandardError = true;
            psi.EnvironmentVariables["NODE_ENV"] = "production";

            _node = new Process();
            _node.StartInfo = psi;
            _node.EnableRaisingEvents = true;
            _node.OutputDataReceived += delegate(object sender, DataReceivedEventArgs e)
            {
                if (e.Data != null) AppendLog("service.out.log", e.Data);
            };
            _node.ErrorDataReceived += delegate(object sender, DataReceivedEventArgs e)
            {
                if (e.Data != null) AppendLog("service.err.log", e.Data);
            };

            if (!_node.Start()) throw new InvalidOperationException("Could not start node.exe.");
            _node.BeginOutputReadLine();
            _node.BeginErrorReadLine();
            AppendLog("service.out.log", "[service] started node pid=" + _node.Id);

            Process child = _node;
            var monitor = new Thread(delegate()
            {
                child.WaitForExit();
                if (_stopping) return;
                AppendLog("service.err.log", "[service] node exited code=" + child.ExitCode + "; SCM recovery will restart the service");
                // Exiting without reporting SERVICE_STOPPED makes the SCM apply
                // the configured failure actions, including when Node exits 0.
                Environment.Exit(1);
            });
            monitor.IsBackground = true;
            monitor.Start();
        }
        catch (Exception ex)
        {
            AppendLog("service.err.log", "[service] start failed: " + ex);
            throw;
        }
    }

    protected override void OnStop()
    {
        RequestAdditionalTime(15000);
        _stopping = true;
        KillTree();
    }

    protected override void OnShutdown()
    {
        RequestAdditionalTime(15000);
        _stopping = true;
        KillTree();
    }

    private void KillTree()
    {
        try
        {
            Process child = _node;
            if (child != null && !child.HasExited)
            {
                using (var killer = new Process())
                {
                    killer.StartInfo.FileName = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.System), "taskkill.exe");
                    killer.StartInfo.Arguments = "/PID " + child.Id + " /T /F";
                    killer.StartInfo.UseShellExecute = false;
                    killer.StartInfo.CreateNoWindow = true;
                    killer.Start();
                    killer.WaitForExit(10000);
                }
                child.WaitForExit(10000);
                AppendLog("service.out.log", "[service] node process tree terminated");
            }
        }
        catch (Exception ex)
        {
            AppendLog("service.err.log", "[service] stop failed: " + ex.Message);
        }
        finally
        {
            if (_node != null)
            {
                _node.Dispose();
                _node = null;
            }
        }
    }

    private void AppendLog(string file, string line)
    {
        try
        {
            if (String.IsNullOrEmpty(_logDir)) return;
            lock (_logLock)
            {
                File.AppendAllText(Path.Combine(_logDir, file),
                    DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss") + " " + line + Environment.NewLine,
                    new UTF8Encoding(false));
            }
        }
        catch { }
    }

    // Correctly quote a Windows command-line argument, including paths with
    // spaces, quotes, or trailing backslashes.
    private static string QuoteArgument(string value)
    {
        var result = new StringBuilder();
        result.Append('"');
        int slashes = 0;
        foreach (char c in value)
        {
            if (c == '\\') { slashes++; continue; }
            if (c == '"')
            {
                result.Append('\\', slashes * 2 + 1);
                result.Append('"');
                slashes = 0;
                continue;
            }
            result.Append('\\', slashes);
            slashes = 0;
            result.Append(c);
        }
        result.Append('\\', slashes * 2);
        result.Append('"');
        return result.ToString();
    }

    static void Main(string[] args)
    {
        ServiceBase.Run(new LocalFileHubService());
    }
}
