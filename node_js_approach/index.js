const WebSocket = require("ws");
const express = require("express");
const WaveFile = require("wavefile").WaveFile;
const axios = require("axios");
require("dotenv").config();

const app = express();
const server = require("http").createServer(app);
const wss = new WebSocket.Server({ server });

const MISTRAL_API_KEY = process.env.MISTRAL_API_KEY;
const DEEPGRAM_API_KEY = process.env.DEEPGRAM_API_KEY;

if (!MISTRAL_API_KEY || !DEEPGRAM_API_KEY) {
    console.error("Missing API keys. Set MISTRAL_API_KEY and DEEPGRAM_API_KEY in environment variables.");
    process.exit(1);
}

let deepgram;
let conversationHistory = {};
let chunks = {};
let timeoutHandlers = {};  // Stores timers to detect inactivity
let partialTranscript = {}; // Stores ongoing speech data

// Handle WebSocket Connection from Twilio
wss.on("connection", function connection(ws) {
    console.log("New Twilio connection initiated");

    ws.on("message", async function incoming(message) {
        if (!deepgram) {
            return console.error("Deepgram WebSocket must be initialized.");
        }

        const msg = JSON.parse(message);

        switch (msg.event) {
            case "connected":
                console.log(`Call connected`);
                deepgram.onerror = console.error;

                let callSid = msg.callSid;
                conversationHistory[callSid] = []; // Initialize conversation history
                partialTranscript[callSid] = "";  // Initialize transcript storage

                deepgram.onmessage = async (deepgramMsg) => {
                    const res = JSON.parse(deepgramMsg.data);

                    if (res.type === "Results" && res.channel?.alternatives?.length > 0) {
                        const transcript = res.channel.alternatives[0].transcript.trim();
                        if (transcript) {
                            console.log("User said:", transcript);

                            partialTranscript[callSid] += ` ${transcript}`.trim();

                            // Reset inactivity timer
                            if (timeoutHandlers[callSid]) clearTimeout(timeoutHandlers[callSid]);

                            timeoutHandlers[callSid] = setTimeout(async () => {
                                // Once inactive for 2 seconds, process the sentence
                                let finalSentence = partialTranscript[callSid].trim();
                                if (finalSentence) {
                                    conversationHistory[callSid].push({ role: "user", content: finalSentence });

                                    // Process AI response
                                    const aiResponse = await queryLLM(conversationHistory[callSid]);
                                    conversationHistory[callSid].push({ role: "assistant", content: aiResponse });

                                    console.log("AI Response:", aiResponse);

                                    // Send AI response back via Twilio
                                    ws.send(JSON.stringify({ event: "speak", text: aiResponse }));

                                    // Clear stored sentence
                                    partialTranscript[callSid] = "";
                                }
                            }, 2000); // 2-second delay after last spoken word
                        }
                    }
                };
                break;

            case "start":
                console.log(`Starting media stream for ${msg.streamSid}`);
                break;

            case "media":
                let twilioData = msg.media.payload;
                let wav = new WaveFile();
                wav.fromScratch(1, 8000, "8m", Buffer.from(twilioData, "base64"));
                wav.fromMuLaw();

                let audioBuffer = wav.toBuffer().subarray(44);
                if (!chunks[msg.streamSid]) {
                    chunks[msg.streamSid] = [];
                }
                chunks[msg.streamSid].push(audioBuffer);

                if (chunks[msg.streamSid].length >= 5) {
                    let combinedBuffer = Buffer.concat(chunks[msg.streamSid]);
                    deepgram.send(combinedBuffer, { binary: true });
                    chunks[msg.streamSid] = [];
                }
                break;

            case "stop":
                console.log(`Call ended`);
                deepgram.send(JSON.stringify({ type: "CloseStream" }));
                delete conversationHistory[msg.callSid]; // Cleanup
                delete chunks[msg.streamSid]; // Cleanup
                delete timeoutHandlers[msg.callSid]; // Cleanup
                delete partialTranscript[msg.callSid]; // Cleanup
                break;
        }
    });
});

// API Endpoint to Start the Call
app.post("/", async (req, res) => {
    deepgram = new WebSocket(
        `wss://api.deepgram.com/v1/listen?encoding=linear16&sample_rate=8000&channels=1&interim_results=true`,
        { headers: { Authorization: `Token ${DEEPGRAM_API_KEY}` } }
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
                Welcome to the AI-powered IVR. How can I assist you today?
            </Say>
            <Pause length='30' />
        </Response>`
    );
});

// Query LLM with Conversation History
async function queryLLM(conversation) {
    try {
        const systemPrompt = `
        You are an intelligent IVR assistant for a hospital. Your goal is to assist callers by providing accurate information about hospital services, including operational hours, address, and general inquiries.

        **Guidelines:**
        1. If asked about hospital hours, mention it's open **Monday to Friday from 8:00 AM to 6:00 PM** and closed on **Saturday & Sunday**.
        2. If asked for the hospital's address, provide the full address in a structured format.
        3. If asked about both, include both in your response.
        4. Keep responses **clear, concise, and professional**.
        5. If the caller asks something you don't know, politely suggest they contact the front desk.

        **Example Responses:**
        - **For Hours:** "The hospital is open **Monday to Friday from 8 AM to 6 PM** and closed on **weekends**."
        - **For Address:** "MediCare Hospital, 1234 Wellness Ave, Springfield, IL, 62704."
        - **For Both:** "The hospital operates **Monday to Friday, 8 AM - 6 PM**, and is closed on weekends. Visit us at **MediCare Hospital, 1234 Wellness Ave, Springfield, IL, 62704**."
        `;

        let formattedHistory = [{ role: "system", content: systemPrompt }, ...conversation];

        let response = await axios.post(
            "https://api.mistral.ai/v1/chat/completions",
            {
                model: "mistral-small",
                messages: formattedHistory
            },
            {
                headers: {
                    Authorization: `Bearer ${MISTRAL_API_KEY}`,
                    "Content-Type": "application/json"
                }
            }
        );

        return response.data.choices[0].message.content;
    } catch (error) {
        console.error("Error querying LLM:", error.response ? error.response.data : error.message);
        return "I'm sorry, I couldn't process your request.";
    }
}

// Start Server
console.log("Listening at Port 8080");
server.listen(8080);
