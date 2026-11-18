using System;
using System.Collections.Generic;
using System.IO;
using System.Text;
using System.Web.Script.Serialization;

// Compiled only inside the test's temporary directory. Implements the read-only reply protocol.
class MeteredFixture
{
    static readonly JavaScriptSerializer Json = new JavaScriptSerializer();
    static void Emit(object frame) { Console.WriteLine(Json.Serialize(frame)); }

    static void Main()
    {
        Console.InputEncoding = new UTF8Encoding(false);
        Console.OutputEncoding = new UTF8Encoding(false);
        string line;
        while ((line = Console.ReadLine()) != null) {
            var frame = Json.Deserialize<Dictionary<string, object>>(line);
            if (!frame.ContainsKey("id")) continue;
            var id = frame["id"];
            string method = (string)frame["method"];
            if (method == "initialize") Emit(new { id, result = new { userAgent = "offline-fixture/1.0.0" } });
            else if (method == "account/read") Emit(new { id, result = new { account = new { type = "apiKey" } } });
            else if (method == "thread/start") Emit(new { id, result = new { thread = new { id = "offline-thread", cwd = Environment.CurrentDirectory } } });
            else if (method == "turn/start") {
                var home = Environment.GetEnvironmentVariable("CODEX_HOME");
                File.AppendAllText(Path.Combine(home, "observed-turns.txt"), "turn/start\n");
                var turn = new { id = "offline-turn", status = "inProgress" };
                Emit(new { id, result = new { turn } });
                var threadId = "offline-thread";
                Emit(new { method = "turn/started", @params = new { threadId, turn } });
                var item = new { type = "agentMessage", id = "message-1", text = "Offline budget verification" };
                Emit(new { method = "item/completed", @params = new { threadId, turnId = turn.id, item } });
                Emit(new { method = "turn/completed", @params = new { threadId, turn = new { turn.id, status = "completed" } } });
            } else Emit(new { id, error = new { code = -32601, message = "unsupported" } });
        }
    }
}
