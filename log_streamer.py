from flask import Flask, Response, render_template_string
import time
import os

app = Flask(__name__)
LOG_FILE_PATH = "logs/conversation.log"

HTML_TEMPLATE = """
<!doctype html>
<html>
<head>
    <title>Live IVR Conversation Logs</title>
    <style>
        body { font-family: monospace; background-color: #1e1e1e; color: #e0e0e0; padding: 20px; }
        #log { white-space: pre-wrap; border: 1px solid #555; padding: 10px; height: 90vh; overflow-y: scroll; background: #000; }
        .user { color: #4FC3F7; }
        .ai { color: #81C784; }
    </style>
</head>
<body>
    <h2>📞 Live IVR Conversation Log</h2>
    <div id="log"></div>
    <script>
        const logDiv = document.getElementById('log');
        const source = new EventSource("/stream");

        source.onmessage = function(event) {
            const line = event.data;
            let span = document.createElement("span");

            if (line.includes("🎤")) {
                span.className = "user";
            } else if (line.includes("🤖")) {
                span.className = "ai";
            }

            span.textContent = line + "\\n";
            logDiv.appendChild(span);
            logDiv.scrollTop = logDiv.scrollHeight;
        };
    </script>
</body>
</html>
"""

@app.route("/")
def index():
    return render_template_string(HTML_TEMPLATE)

@app.route("/stream")
def stream():
    def generate():
        if not os.path.exists(LOG_FILE_PATH):
            open(LOG_FILE_PATH, "a").close()

        with open(LOG_FILE_PATH, "r") as f:
            f.seek(0, os.SEEK_END)
            while True:
                line = f.readline()
                if not line:
                    time.sleep(0.5)
                    continue
                yield f"data: {line.strip()}\n\n"
    return Response(generate(), mimetype="text/event-stream")

if __name__ == "__main__":
    app.run(debug=False, port=5050, threaded=True)
