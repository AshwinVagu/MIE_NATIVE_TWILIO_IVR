(async () => {
    if (typeof global.Headers === 'undefined') {
      const fetch = await import('node-fetch');
      global.Headers = fetch.Headers;
    }
  
    const WebSocket = require("ws");
    const express = require("express");
    const WaveFile = require("wavefile").WaveFile;
    const axios = require("axios");
    const fs = require("fs");
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
    let speakingState = {};
  
    function linearToMuLaw(sample) {
        const MU_LAW_MAX = 0x1FFF;
        const BIAS = 0x84;
        const CLIP = 32635;
  
        sample = Math.max(-CLIP, Math.min(CLIP, sample));
        let sign = (sample < 0) ? 0x80 : 0;
        if (sign) sample = -sample;
  
        sample += BIAS;
        let exponent = 7;
        for (let expMask = 0x4000; (sample & expMask) === 0 && exponent > 0; expMask >>= 1) {
            exponent--;
        }
  
        const mantissa = (sample >> ((exponent === 0) ? 4 : (exponent + 3))) & 0x0F;
        return ~(sign | (exponent << 4) | mantissa) & 0xFF;
    }
  
    function pcmToMuLaw(pcmBuffer) {
        const output = Buffer.alloc(pcmBuffer.length / 2);
        for (let i = 0; i < output.length; i++) {
            const sample = pcmBuffer.readInt16LE(i * 2);
            output[i] = linearToMuLaw(sample);
        }
        return output;
    }

    function chunkBuffer(buffer, chunkSize) {
        let chunks = [];
        for (let i = 0; i < buffer.length; i += chunkSize) {
            chunks.push(buffer.slice(i, i + chunkSize));
        }
        return chunks;
    }

    async function synthesizeWithDeepgram(text) {
        try {
            const response = await axios.post(
                "https://api.deepgram.com/v1/speak?model=aura-asteria-en&encoding=linear16&sample_rate=8000",
                { text },
                {
                    headers: {
                        Authorization: `Token ${DEEPGRAM_API_KEY}`,
                        "Content-Type": "application/json"
                    },
                    responseType: "arraybuffer"
                }
            );
            return Buffer.from(response.data);
        } catch (error) {
            console.error("Deepgram TTS failed:", error.response?.data || error.message);
            throw error;
        }
    }
    
  
    async function streamAIResponseToTwilio(ws, aiResponse, streamSid, callSid) {
        try {
            speakingState[callSid] = true;
    
            const pcmBuffer = await synthesizeWithDeepgram(aiResponse);
            const muLawBuffer = pcmToMuLaw(pcmBuffer);
            const audioChunks = chunkBuffer(muLawBuffer, 320); // 320 bytes = 20ms at 8kHz
    
            console.log("Streaming TTS audio in chunks...");
    
            for (let chunk of audioChunks) {
                // Stop streaming if barge-in occurred
                if (!speakingState[callSid] || ws.readyState !== WebSocket.OPEN) {
                    console.log("TTS interrupted by user speech.");
                    break;
                }
    
                const payload = chunk.toString('base64');
                ws.send(JSON.stringify({ event: "media", streamSid, media: { payload } }));
    
                // Wait ~20ms to simulate real-time playback
                await new Promise(resolve => setTimeout(resolve, 20));
            }
    
            // Mark end of TTS (if not interrupted)
            if (ws.readyState === WebSocket.OPEN && speakingState[callSid]) {
                ws.send(JSON.stringify({ event: "mark", streamSid, mark: { name: "tts_response_end" } }));
            }
    
            speakingState[callSid] = false;
    
        } catch (err) {
            console.error("Error streaming AI response:", err);
            speakingState[callSid] = false;
        }
    }
  
    wss.on("connection", function connection(ws) {
        console.log("New Twilio connection initiated");
  
        ws.on("message", async function incoming(message) {
            if (!deepgram || deepgram.readyState !== WebSocket.OPEN) {
                return console.error("Deepgram WebSocket is not open.");
            }
  
            const msg = JSON.parse(message);
  
            switch (msg.event) {
                case "connected":
                    console.log(`Call connected`);
                    deepgram.onerror = console.error;
  
                    let callSid = msg.callSid;
                    conversationHistory[callSid] = [];
                    partialTranscript[callSid] = "";
  
                    deepgram.onmessage = async (deepgramMsg) => {
                        const res = JSON.parse(deepgramMsg.data);
                    
                        if (res.type === "Results" && res.channel?.alternatives?.length > 0) {
                            const transcript = res.channel.alternatives[0].transcript.trim();
                    
                            if (transcript) {
                                console.log("User said:", transcript);
                    
                                // Barge-in detection: only now do we interrupt
                                if (speakingState[callSid]) {
                                    console.log("Barge-in detected via valid transcript. Interrupting...");
                                    speakingState[callSid] = false;
                                }
                    
                                partialTranscript[callSid] += ` ${transcript}`.trim();
                    
                                if (timeoutHandlers[callSid]) clearTimeout(timeoutHandlers[callSid]);
                    
                                timeoutHandlers[callSid] = setTimeout(async () => {
                                    let finalSentence = partialTranscript[callSid].trim();
                                    if (finalSentence) {
                                        conversationHistory[callSid].push({ role: "user", content: finalSentence });
                    
                                        const aiResponse = await queryLLM(conversationHistory[callSid]);
                                        conversationHistory[callSid].push({ role: "assistant", content: aiResponse });
                    
                                        console.log("AI Response:", aiResponse);
                    
                                        const streamSid = Object.keys(chunks)[0];  // or maintain streamSid<->callSid map
                                        await streamAIResponseToTwilio(ws, aiResponse, streamSid, callSid);
                    
                                        partialTranscript[callSid] = "";
                                    }
                                }, 2000);
                            }
                        }
                    };
                    break;
  
                case "start":
                    console.log(`Starting media stream for ${msg.streamSid}`);
                    await greetingMessage(ws, msg.streamSid);
                    break;
  
                case "media":
                    const twilioData = msg.media.payload;
                    const wav = new WaveFile();
                    wav.fromScratch(1, 8000, "8m", Buffer.from(twilioData, "base64"));
                    wav.fromMuLaw();
                
                    const audioBuffer = Buffer.from(wav.data.samples);
                    const streamSid = msg.streamSid;
                
                    let inferredCallSid = Object.keys(conversationHistory).find(sid => chunks[streamSid]) || msg.callSid;
                
                    if (!chunks[streamSid]) {
                        chunks[streamSid] = [];
                    }
                
                    chunks[streamSid].push(audioBuffer);
                
                    if (chunks[streamSid].length >= 5) {
                        const combinedBuffer = Buffer.concat(chunks[streamSid]);
                        deepgram.send(combinedBuffer, { binary: true });
                        chunks[streamSid] = [];
                    }
                    break;

                case "mark":
                    if (msg.mark.name === "tts_response_end") {
                        speakingState[msg.callSid] = false;
                        console.log("AI finished speaking.");
                    }
                    break;    
  
                case "stop":
                    console.log(`Call ended`);
                    deepgram.send(JSON.stringify({ type: "CloseStream" }));
                    delete conversationHistory[msg.callSid];
                    delete chunks[msg.streamSid];
                    delete timeoutHandlers[msg.callSid];
                    delete partialTranscript[msg.callSid];
                    break;
            }
        });
    });
  
    app.post("/", async (req, res) => {
        deepgram = await new Promise((resolve, reject) => {
            const dgSocket = new WebSocket(
                `wss://api.deepgram.com/v1/listen?encoding=linear16&sample_rate=8000&channels=1&interim_results=true`,
                { headers: { Authorization: `Token ${DEEPGRAM_API_KEY}` } }
            );
    
            dgSocket.onopen = () => {
                dgSocket.send(JSON.stringify({
                    type: "Configure",
                    encoding: "linear16",
                    sample_rate: 8000,
                    channels: 1,
                    interim_results: true
                }));
                console.log("Deepgram WebSocket is now OPEN.");
                resolve(dgSocket);
            };
    
            dgSocket.onerror = (err) => {
                console.error("Failed to connect to Deepgram:", err);
                reject(err);
            };
        });
    
        res.set("Content-Type", "text/xml");
        res.send(
            `<Response>
                <Connect>
                    <Stream url='wss://${req.headers.host}' />
                </Connect>
            </Response>`
        );
    });


    async function greetingMessage(ws, streamSid) {
        const greetingText = "Welcome to the automated assistant. What can I help you with today?";
        await streamAIResponseToTwilio(ws, greetingText, streamSid);
    } 
  
    async function queryLLM(conversation) {
        try {
            const systemPrompt = `
            You are an intelligent IVR assistant for a hospital. Your goal is to assist callers by providing accurate information about the hospital, including operational hours, address, and general guidance. 

            You should always respond in a **polite and professional tone**, ensuring clarity in communication. When a caller asks about hospital timings, provide them with the correct schedule, including open and closed hours. If they ask for the hospital's address, provide the full location in a structured manner.

            **Key Instructions:**
            1. If a caller asks about hospital hours, state the operating hours from **Monday to Friday** and inform them that the hospital is closed on **Saturday and Sunday**.
            2. If a caller requests the hospital's address, provide the full address in a clear format.
            3. If a caller asks about both the **timings and address**, provide both details in a well-structured response.
            4. Ensure responses are **concise, yet complete**, to avoid confusion for the caller.
            5. If the caller asks a question that you **do not have an answer for**, kindly inform them that they can reach the hospital directly for further inquiries.
            6. Finally after giving a caller a complete answer(That does not include answers where you needed a detail and investigated from the user), ask the callers if they have any more questions.
            If the caller has no more questions, end the conversation politely and ask the user to hang up the phone call.

            Example Responses:

            **For Hospital Timings Inquiry:**
            "The hospital operates from **Monday to Friday**, between **8:00 AM and 6:00 PM**. Please note that we are closed on **Saturdays and Sundays**."

            **For Hospital Address Inquiry:**
            "Our hospital is located at:
            **MediCare General Hospital**
            1234 Wellness Avenue,
            Springfield, IL, 62704, USA."

            **For Both Timings and Address Inquiry:**
            "Thank you for contacting MediCare General Hospital. Our operating hours are **Monday to Friday from 8:00 AM to 6:00 PM**. We remain **closed on Saturdays and Sundays**.  
            You can visit us at:  
            **MediCare General Hospital**  
            1234 Wellness Avenue,  
            Springfield, IL, 62704, USA.  
            If you need any further assistance, feel free to contact our front desk."

            Ensure that all responses are **formatted clearly**, so the caller can easily understand the details.
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
  
    console.log("Listening at Port 8080");
    server.listen(8080);
  })();
  