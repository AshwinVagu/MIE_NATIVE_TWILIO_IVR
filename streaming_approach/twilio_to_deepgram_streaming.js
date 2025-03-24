const WebSocket = require("ws");
const express = require("express");
const WaveFile = require("wavefile").WaveFile;

const path = require("path")
const app = express();
const server = require("http").createServer(app);
const wss = new WebSocket.Server({ server });

let deepgram;
let chunks = [];

// Handle Web Socket Connection
wss.on("connection", function connection(ws) {
  console.log("New Connection Initiated");

  ws.on("message", function incoming(message) {
    if (!deepgram)
      return console.error("Deepgram's WebSocket must be initialized.");

    const msg = JSON.parse(message);

     // Handle messages from Twilio
    switch (msg.event) {
      case "connected": 
        console.log(`A new call has connected.`);
        deepgram.onerror = console.error;
        const texts = {};
        console.log("Deepgram is connected");
        deepgram.onmessage = (deepgramMsg) => {
          const res = JSON.parse(deepgramMsg.data);
      
          // Ensure it is a result message
            if (res.type === "Results") {
                // Ensure `res.channel` and `res.channel.alternatives` exist
                if (res.channel && res.channel.alternatives && res.channel.alternatives.length > 0) {
                    const transcript = res.channel.alternatives[0].transcript;
                    if (transcript) {
                        texts[res.start] = transcript;
        
                        const keys = Object.keys(texts);
                        keys.sort((a, b) => a - b);
                        let msg = '';
                        for (const key of keys) {
                            if (texts[key]) {
                                msg += ` ${texts[key]}`;
                                console.log("Transcription:", texts[key]);
                            }
                        }
                        return; // Return to avoid the warning message.
                    }
                }
            }
            console.warn("Deepgram response does not contain transcription.");
        };
        break;
      case "start":
        console.log(`Starting Media Stream ${msg.streamSid}`);
        break;
      case "media":
        const twilioData = msg.media.payload;
        let wav = new WaveFile();
        wav.fromScratch(1, 8000, "8m", Buffer.from(twilioData, "base64"));
        wav.fromMuLaw();
        const twilioAudioBuffer = wav.toBuffer(); // Get raw buffer instead of base64
        chunks.push(twilioAudioBuffer.subarray(44));
    
        if (chunks.length >= 5) {
            const audioBuffer = Buffer.concat(chunks);
            deepgram.send(audioBuffer, { binary: true }); // Send raw buffer
            chunks = [];
        }
        break;
      case "stop":
        console.log(`Call Has Ended`);
        deepgram.send(JSON.stringify({ type: "CloseStream" }));
        break;
    }
  });
});



app.post("/", async (req, res) => {
    deepgram = new WebSocket(
        "wss://api.deepgram.com/v1/listen?encoding=linear16&sample_rate=8000&channels=1&interim_results=true", //Added query parameters
        { headers: { Authorization: "Token 824d0e4aca6d0f83dd3779671ff594dd9dcc30e7" } }
    );

    deepgram.onopen = () => {
        deepgram.send(JSON.stringify({
            "type": "Configure",
            "encoding": "linear16",
            "sample_rate": 8000,
            "channels": 1,
            "interim_results": true
        }));
    };

    res.set("Content-Type", "text/xml");
    res.send(
        `<Response>
       <Start>
         <Stream url='wss://${req.headers.host}' />
       </Start>
       <Say>
         Start speaking to see your audio transcribed in the console
       </Say>
       <Pause length='30' />
     </Response>`
    );
});

// Start server
console.log("Listening at Port 8080");
server.listen(8080);