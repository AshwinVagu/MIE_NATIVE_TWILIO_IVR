const express = require('express');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = 5050;
const LOG_FILE_PATH = path.join(__dirname, 'logs/conversation.log');

// Serve the HTML directly
app.get('/', (req, res) => {
  res.send(`
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
  `);
});


// SSE log streaming endpoint
app.get('/stream', (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
  
    if (!fs.existsSync(LOG_FILE_PATH)) {
      fs.writeFileSync(LOG_FILE_PATH, '');
    }
  
    let lastSize = fs.statSync(LOG_FILE_PATH).size;
  
    const interval = setInterval(() => {
      fs.stat(LOG_FILE_PATH, (err, stats) => {
        if (err) return;
  
        if (stats.size > lastSize) {
          const stream = fs.createReadStream(LOG_FILE_PATH, {
            encoding: 'utf8',
            start: lastSize,
            end: stats.size
          });
  
          let buffer = '';
          stream.on('data', chunk => {
            buffer += chunk;
          });
  
          stream.on('end', () => {
            const lines = buffer.trim().split('\n');
            for (const line of lines) {
              res.write(`data: ${line}\n\n`);
            }
            lastSize = stats.size;
          });
        }
      });
    }, 1000); // Check every 1s
  
    req.on('close', () => {
      clearInterval(interval);
      res.end();
    });
  });
  

app.listen(PORT, () => {
  console.log(`Live IVR log viewer running at http://localhost:${PORT}`);
});
