// Ensure global.Headers is defined for node-fetch compatibility if needed
// This block ensures node-fetch Headers are available in environments where they might not be by default,
// such as older Node.js versions or specific execution contexts.
(async () => {
    if (typeof global.Headers === 'undefined') {
        const fetch = await import('node-fetch');
        global.Headers = fetch.Headers;
    }

    // Required Node.js modules for WebSocket server, HTTP server, audio processing, and environment variables.
    const WebSocket = require("ws");
    const express = require("express");
    const WaveFile = require("wavefile").WaveFile;
    const axios = require("axios");
    require("dotenv").config(); // Loads environment variables from a .env file

    // Initialize Express application and WebSocket server.
    const app = express();
    const server = require("http").createServer(app);
    const wss = new WebSocket.Server({ server });

    // API keys. GEMINI_API_KEY for Gemini's text/audio understanding.
    // DEEPGRAM_API_KEY is reintroduced for Text-to-Speech as Gemini 2.0 Flash's generateContent
    // does not support audio output directly.
    const GEMINI_API_KEY = process.env.GEMINI_API_KEY || "";
    const DEEPGRAM_API_KEY = process.env.DEEPGRAM_API_KEY; // Reintroduced for TTS

    // Check if the API keys are available.
    if (!GEMINI_API_KEY) {
        console.warn("GEMINI_API_KEY not found in environment variables. Assuming Canvas environment will provide it.");
    }
    if (!DEEPGRAM_API_KEY) {
        console.error("DEEPGRAM_API_KEY is required for Text-to-Speech. Please set it in your environment variables.");
        process.exit(1);
    }

    // Global state management for different calls.
    // Stores conversation history for each unique call (identified by callSid).
    let conversationHistory = {};
    // Buffers incoming audio chunks from Twilio for each stream.
    let incomingAudioBuffers = {};
    // Stores timers to detect inactivity after user speech.
    let timeoutHandlers = {};
    // Tracks if the AI is currently speaking to enable barge-in.
    let speakingState = {};
    // NEW: Map to store the relationship between streamSid and callSid
    let streamSidToCallSidMap = {};

    // --- Audio Utility Functions ---

    /**
     * Converts a linear (PCM) audio sample to Mu-law companded sample.
     * This function is crucial for converting Linear16 audio (which Deepgram TTS outputs)
     * into Mu-Law, which Twilio typically expects for streaming.
     * @param {number} sample - The 16-bit signed linear PCM sample.
     * @returns {number} - The 8-bit Mu-Law companded sample.
     */
    function linearToMuLaw(sample) {
        const MU_LAW_MAX = 0x1FFF;
        const BIAS = 0x84; // 132 for Mu-Law
        const CLIP = 32635; // Maximum 16-bit signed value is 32767, clips slightly below to match standard.

        // Clip the sample to prevent overflow and match Mu-Law encoding range.
        sample = Math.max(-CLIP, Math.min(CLIP, sample));
        // Determine the sign of the sample.
        let sign = (sample < 0) ? 0x80 : 0;
        if (sign) sample = -sample; // Work with absolute value for encoding.

        // Add bias before logarithm.
        sample += BIAS;

        // Determine the exponent for Mu-Law encoding (segment).
        let exponent = 7; // Max exponent
        for (let expMask = 0x4000; (sample & expMask) === 0 && exponent > 0; expMask >>= 1) {
            exponent--;
        }

        // Determine the mantissa (value within the segment).
        // The shift amount depends on the exponent.
        const mantissa = (sample >> ((exponent === 0) ? 4 : (exponent + 3))) & 0x0F;

        // Combine sign, exponent, and mantissa. Invert all bits for Mu-Law.
        return ~(sign | (exponent << 4) | mantissa) & 0xFF;
    }

    /**
     * Converts a PCM (Linear16) audio buffer to a Mu-Law audio buffer.
     * @param {Buffer} pcmBuffer - The input Buffer containing 16-bit Linear PCM audio samples.
     * @returns {Buffer} - The output Buffer containing 8-bit Mu-Law audio samples.
     */
    function pcmToMuLaw(pcmBuffer) {
        // Output buffer will be half the size of the PCM buffer (16-bit PCM to 8-bit Mu-Law).
        const output = Buffer.alloc(pcmBuffer.length / 2);
        for (let i = 0; i < output.length; i++) {
            // Read 16-bit signed integer from PCM buffer.
            const sample = pcmBuffer.readInt16LE(i * 2);
            // Convert to Mu-Law and store in the output buffer.
            output[i] = linearToMuLaw(sample);
        }
        return output;
    }

    /**
     * Chunks a given buffer into smaller buffers of a specified size.
     * Used for streaming audio to Twilio.
     * @param {Buffer} buffer - The input buffer to chunk.
     * @param {number} chunkSize - The desired size of each chunk.
     * @returns {Buffer[]} - An array of smaller buffer chunks.
     */
    function chunkBuffer(buffer, chunkSize) {
        let chunks = [];
        for (let i = 0; i < buffer.length; i += chunkSize) {
            chunks.push(buffer.slice(i, i + chunkSize));
        }
        return chunks;
    }

    /**
     * Synthesizes speech from text using Deepgram's Text-to-Speech API.
     * This function is used as the TTS component after Gemini processes the audio and generates text.
     * @param {string} text - The text to synthesize into speech.
     * @returns {Promise<Buffer>} - A promise that resolves with the Linear16 PCM audio buffer.
     */
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

    // --- Gemini API Interaction ---

    /**
     * Calls the Gemini API to process audio input and generate a text response.
     * This function encapsulates the core multimodal interaction with Gemini (STT + LLM).
     * @param {Buffer} audioBuffer - The concatenated Linear16 PCM audio buffer from the user.
     * @param {string} callSid - The unique ID for the call, used to manage conversation history.
     * @returns {Promise<string>} - A promise resolving to the generated text response from Gemini.
     */
    async function geminiGenerateContent(audioBuffer, callSid) {
        try {
            // Encode the audio buffer to Base64 for inline data in the Gemini request.
            const base64Audio = audioBuffer.toString('base64');
            console.log(`Sending ${audioBuffer.length} bytes of audio to Gemini.`);
            

            // Retrieve the current conversation history for this call.
            // Format it into parts suitable for the Gemini API.
            const historyForGemini = conversationHistory[callSid].map(msg => ({
                role: msg.role === 'user' ? 'user' : 'model', // Adjust roles for Gemini
                parts: [{ text: msg.content }]
            }));

            // System prompt for the IVR assistant. This guides Gemini's behavior.
            const systemPrompt = `
                You are an intelligent IVR assistant for a hospital. Your goal is to assist callers by providing accurate information about the hospital, including operational hours, address, and general guidance.

                You should always respond in a **polite and professional tone**, ensuring clarity in communication. When a caller asks about hospital timings, provide them with the correct schedule, including open and closed hours. If they ask for the hospital's address, provide the full location in a structured manner.

                **Key Instructions:**
                1. If a caller asks about hospital hours, state the operating hours from **Monday to Friday** and inform them that the hospital is closed on **Saturday and Sunday**. The hospital operates from **8:00 AM to 6:00 PM**.
                2. If a caller requests the hospital's address, provide the full address in a clear format: "Our hospital is located at: MediCare General Hospital, 1234 Wellness Avenue, Springfield, IL, 62704, USA."
                3. If a caller asks about both the **timings and address**, provide both details in a well-structured response.
                4. Ensure responses are **concise, yet complete**, to avoid confusion for the caller.
                5. If the caller asks a question that you **do not have an answer for**, kindly inform them that they can reach the hospital directly for further inquiries.
                6. After giving a caller a complete answer (that does not include answers where you needed a detail and investigated from the user), ask the callers if they have any more questions.
                7. If the caller has no more questions or indicates they are done, end the conversation politely and ask the user to hang up the phone call.

                Example Responses:

                **For Hospital Timings Inquiry:**
                "The hospital operates from Monday to Friday, between 8:00 AM and 6:00 PM. Please note that we are closed on Saturdays and Sundays. Do you have any more questions?"

                **For Hospital Address Inquiry:**
                "Our hospital is located at: MediCare General Hospital, 1234 Wellness Avenue, Springfield, IL, 62704, USA. Is there anything else I can help you with?"

                **For Both Timings and Address Inquiry:**
                "Thank you for contacting MediCare General Hospital. Our operating hours are Monday to Friday from 8:00 AM to 6:00 PM. We remain closed on Saturdays and Sundays. You can visit us at: MediCare General Hospital, 1234 Wellness Avenue, Springfield, IL, 62704, USA. If you need any further assistance, feel free to contact our front desk."

                Ensure that all responses are **formatted clearly**, so the caller can easily understand the details.
            `;

            // The 'contents' array for the Gemini API request.
            // It includes the system prompt, historical text conversation, and the current audio input.
            const payloadContents = [
                {
                  role: "user",
                  parts: [{ text: systemPrompt }]
                },
                ...historyForGemini,
                {
                  role: "user",
                  parts: [
                    {
                      inlineData: {
                        mimeType: "audio/raw",  // REQUIRED: change from audio/pcm
                        data: base64Audio
                      }
                    }
                  ]
                }
              ];

            const apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${GEMINI_API_KEY}`;
            console.log("Calling Gemini API...");

            const response = await axios.post(
                apiUrl,
                {
                    contents: payloadContents,
                    // IMPORTANT: Removed 'responseMimeType: "audio/webm"' as it's not supported by this endpoint for output.
                    // Gemini will return a text response by default.
                },
                {
                    headers: {
                        'Content-Type': 'application/json'
                    }
                }
            );

            // Parse the response. Gemini returns a JSON object with text content.
            const responseData = response.data;

            if (responseData.candidates && responseData.candidates.length > 0 && responseData.candidates[0].content && responseData.candidates[0].content.parts && responseData.candidates[0].content.parts.length > 0) {
                const generatedText = responseData.candidates[0].content.parts[0].text;
                console.log(`Received text response from Gemini: "${generatedText.trim()}"`);
                return generatedText.trim();
            } else {
                console.error("Unexpected Gemini response structure:", JSON.stringify(responseData, null, 2));
                return "I'm sorry, I couldn't process your request or generate a text response from Gemini.";
            }

        } catch (error) {
            console.error("Error calling Gemini API:", error.response ? error.response.data : error.message);
            return "I'm sorry, I encountered an error while processing your request with Gemini.";
        }
    }

    /**
     * Streams an AI-generated audio response to the Twilio WebSocket.
     * This function handles conversion from Linear16 PCM (from Deepgram TTS)
     * to Twilio's expected Mu-Law format, and then streams in small chunks.
     * @param {WebSocket} ws - The Twilio WebSocket connection.
     * @param {Buffer} aiAudioBuffer - The Linear16 PCM audio buffer received from Deepgram TTS.
     * @param {string} streamSid - The Twilio media stream SID.
     * @param {string} callSid - The Twilio call SID.
     */
    async function streamAIResponseToTwilio(ws, aiAudioBuffer, streamSid, callSid) {
        try {
            if (!aiAudioBuffer) {
                console.warn("No AI audio buffer provided to stream.");
                return;
            }

            // Set speaking state to true to prevent barge-in during AI speech.
            speakingState[callSid] = true;

            // Convert Linear16 PCM to Mu-Law for Twilio streaming.
            const muLawBuffer = pcmToMuLaw(aiAudioBuffer);
            const audioChunks = chunkBuffer(muLawBuffer, 160); // 160 bytes = 20ms at 8kHz Mu-Law

            console.log(`Streaming TTS audio in ${audioChunks.length} chunks...`);

            for (let i = 0; i < audioChunks.length; i++) {
                const chunk = audioChunks[i];
                // Check if barge-in occurred or WebSocket is closed before sending each chunk.
                // The speakingState[callSid] can be set to false by barge-in detection in media handler.
                if (!speakingState[callSid] || ws.readyState !== WebSocket.OPEN) {
                    console.log("TTS interrupted by user speech or WebSocket closed.");
                    break; // Stop streaming if interrupted
                }

                // Convert audio chunk to Base64 for Twilio.
                const payload = chunk.toString('base64');
                ws.send(JSON.stringify({ event: "media", streamSid, media: { payload } }));

                // Wait approximately 20ms to simulate real-time playback for an 8kHz 160-byte chunk.
                await new Promise(resolve => setTimeout(resolve, 20));
            }

            // Mark the end of TTS (if not interrupted) to signal Twilio.
            if (ws.readyState === WebSocket.OPEN && speakingState[callSid]) {
                ws.send(JSON.stringify({ event: "mark", streamSid, mark: { name: "tts_response_end" } }));
            }

            // Reset speaking state after AI finishes or is interrupted.
            speakingState[callSid] = false;

        } catch (err) {
            console.error("Error streaming AI response:", err);
            speakingState[callSid] = false; // Ensure speaking state is reset on error
        }
    }

    function isSilent(buffer, threshold = 1000) {
        let total = 0;
        for (let i = 0; i < buffer.length; i += 2) {
            const sample = buffer.readInt16LE(i);
            total += Math.abs(sample);
        }
        const avg = total / (buffer.length / 2);
        return avg < threshold;
    }

    // --- Twilio WebSocket Server Events ---

    wss.on("connection", function connection(ws) {
        console.log("New Twilio connection initiated");

        ws.on("message", async function incoming(message) {
            const msg = JSON.parse(message);

            // Reintroduce and use streamSidToCallSidMap
            let callSid;
            let streamSid = msg.streamSid; // streamSid is reliably present in 'start', 'media', 'mark', 'stop'

            switch (msg.event) {
                case "connected":
                    // CallSid is available here, but streamSid is not.
                    // We will rely on the 'start' event to get both and establish the mapping.
                    console.log(`Call connected! Call SID: ${msg.callSid}`);
                    break;

                case "start":
                    console.log("Twilio call connected with msg:", msg);
                    callSid = msg.start.callSid; // CallSid comes from msg.start for 'start' event
                    streamSid = msg.streamSid; // streamSid is direct on msg for 'start' event

                    // Store the mapping from streamSid to callSid
                    streamSidToCallSidMap[streamSid] = callSid;

                    console.log(`Call SID: ${callSid}, Stream SID: ${streamSid}`);

                    // Initialize state for the new call using callSid.
                    conversationHistory[callSid] = [];
                    incomingAudioBuffers[callSid] = Buffer.alloc(0); // Initialize an empty buffer for incoming audio
                    speakingState[callSid] = false; // AI is not speaking initially (before greeting)
                    // Send an initial greeting message.
                    await greetingMessage(ws, streamSid, callSid);
                    break;

                case "media":
                    // Retrieve callSid from the map using streamSid
                    callSid = streamSidToCallSidMap[streamSid];

                    if (!callSid) {
                        console.error(`Call SID not found for stream SID: ${streamSid}. Cannot process media.`);
                        return; // Exit if callSid is not found, prevent further errors.
                    }

                    // Twilio sends Mu-Law audio; need to convert to Linear16 PCM for Gemini.
                    // Correctly extract the base64 audio payload.
                    const twilioData = msg.media.payload; 
                    

                    if (typeof twilioData !== 'string' || twilioData.length === 0) { // Check type and length
                        console.warn("Received invalid type or empty media payload (length 0) from Twilio. Skipping audio processing.");
                        return;
                    }

                    // Convert Mu-Law to Linear16 PCM
                    try {
                        const wav = new WaveFile();
                        wav.fromScratch(1, 8000, "8m", Buffer.from(twilioData, "base64")); // From Mu-Law 8kHz
                        wav.fromMuLaw(); // Convert internal samples to Linear16
                        const audioBufferLinear16 = Buffer.from(wav.data.samples); // Extract Linear16 PCM data


                        if (isSilent(audioBufferLinear16)) {
                            return; // skip resetting timer for silence
                        }

                        // Append the current audio chunk to the accumulated buffer for this call.
                        incomingAudioBuffers[callSid] = Buffer.concat([incomingAudioBuffers[callSid], audioBufferLinear16]);

                        // Clear any existing inactivity timer as user is still speaking.
                        if (timeoutHandlers[callSid]) {
                            clearTimeout(timeoutHandlers[callSid]);
                        }

                        // Set a new timer to detect the end of user's speech.
                        // If no new audio comes in within 700ms, assume the user has finished speaking.
                        timeoutHandlers[callSid] = setTimeout(async () => {
                            console.log("User speech timeout triggered. Processing full audio segment.");

                            const currentAudioSegment = incomingAudioBuffers[callSid];
                            incomingAudioBuffers[callSid] = Buffer.alloc(0); // Clear the buffer for the next segment.
                            console.log(`Processing audio segment of length: ${currentAudioSegment.length}`);

                            if (currentAudioSegment.length > 0) {
                                // Call Gemini with the accumulated audio to get a text response.
                                const aiTextResponse = await geminiGenerateContent(currentAudioSegment, callSid);

                                // --- Refined Barge-in logic ---
                                // If AI was speaking AND Gemini detected meaningful speech from user
                                // `aiTextResponse.length > 0` indicates Gemini actually transcribed something.
                                if (speakingState[callSid] && aiTextResponse.length > 0) {
                                    console.log("Confirmed barge-in by meaningful user speech. Interrupting AI speech.");
                                    speakingState[callSid] = false; // This will stop current AI streaming in streamAIResponseToTwilio
                                    // We proceed to generate a response to the user's speech.
                                }

                                // Update conversation history with the inferred user speech and AI's text response.
                                const userContent = aiTextResponse.length > 0 ? `User: ${aiTextResponse}` : "User: (Silence/Non-speech detected)";
                                conversationHistory[callSid].push({ role: "user", content: userContent });
                                conversationHistory[callSid].push({ role: "assistant", content: aiTextResponse });
                                console.log("AI Text Response:", aiTextResponse);

                                // Only synthesize and stream AI response if AI is not currently speaking OR
                                // if AI was speaking but user only produced silence/noise (aiTextResponse.length === 0).
                                // This prevents the bot from talking over the user's continued speech after a true barge-in.
                                if (!speakingState[callSid] || aiTextResponse.length === 0) {
                                    // Synthesize the AI's text response into audio using Deepgram TTS.
                                    const aiAudioBuffer = await synthesizeWithDeepgram(aiTextResponse);

                                    // Stream the synthesized audio back to Twilio.
                                    await streamAIResponseToTwilio(ws, aiAudioBuffer, streamSid, callSid);
                                } else {
                                    console.log("AI was speaking and meaningful user speech was detected. Skipping new AI response to avoid talking over the user.");
                                }

                            } else {
                                console.log("No audio received in the segment, nothing to process for Gemini.");
                            }
                        }, 700); // Adjust this timeout as needed for responsiveness vs. complete sentences.
                    } catch (audioConversionError) {
                        console.error("Error during audio conversion (Mu-Law to Linear16):", audioConversionError.message);
                        console.error("Problematic Twilio data (first 100 chars):", twilioData.substring(0, 100));
                        return; // Stop processing this specific media chunk if conversion fails
                    }
                    break;

                case "mark":
                    // Retrieve callSid from the map using streamSid
                    callSid = streamSidToCallSidMap[streamSid];
                    if (!callSid) {
                        console.error(`Call SID not found for stream SID: ${streamSid}. Cannot process mark.`);
                        return;
                    }
                    // This event is sent by Twilio when a mark we sent is acknowledged.
                    // Used here to confirm AI finished speaking if not interrupted.
                    if (msg.mark.name === "tts_response_end") {
                        speakingState[callSid] = false;
                        console.log("AI finished speaking and mark received.");
                    }
                    break;

                case "stop":
                    // Retrieve callSid from the map using streamSid
                    callSid = streamSidToCallSidMap[streamSid];
                    if (!callSid) {
                        console.error(`Call SID not found for stream SID: ${streamSid}. Cannot stop processing.`);
                    } else {
                        console.log(`Call ended for SID: ${callSid}`);
                        // Clean up resources associated with the ended call.
                        if (timeoutHandlers[callSid]) {
                            clearTimeout(timeoutHandlers[callSid]);
                        }
                        delete conversationHistory[callSid];
                        delete incomingAudioBuffers[callSid];
                        delete timeoutHandlers[callSid];
                        delete speakingState[callSid];
                    }
                    // Always clean up the streamSid mapping for this stream
                    delete streamSidToCallSidMap[streamSid];
                    break;
            }
        });

        // Handle WebSocket errors.
        ws.on("error", (error) => {
            console.error("Twilio WebSocket error:", error);
        });

        // Handle WebSocket close.
        ws.on("close", () => {
            console.log("Twilio WebSocket closed.");
        });
    });

    // --- HTTP Endpoint for Twilio Webhook ---

    // This endpoint handles Twilio's initial webhook request to establish the media stream.
    app.post("/", async (req, res) => {
        // Twilio expects a TwiML response to set up the media stream.
        res.set("Content-Type", "text/xml");
        res.send(
            `<Response>
                <Connect>
                    <Stream url='wss://${req.headers.host}' />
                </Connect>
            </Response>`
        );
        console.log("Sent TwiML response to Twilio to connect stream.");
    });

    // --- Greeting Message Function ---

    /**
     * Sends an initial greeting message to the user when the call starts.
     * This uses Deepgram TTS to generate the audio for the greeting.
     * @param {WebSocket} ws - The Twilio WebSocket connection.
     * @param {string} streamSid - The Twilio media stream SID.
     * @param {string} callSid - The Twilio call SID.
     */
    async function greetingMessage(ws, streamSid, callSid) {
        const greetingText = "Welcome to the automated assistant. What can I help you with today?";
        // Add the greeting to the conversation history for the assistant.
        // Make sure conversationHistory[callSid] is initialized before pushing to it.
        if (!conversationHistory[callSid]) {
             conversationHistory[callSid] = [];
        }
        conversationHistory[callSid].push({ role: "assistant", content: greetingText });

        // Synthesize the greeting text using Deepgram TTS.
        const aiAudioBuffer = await synthesizeWithDeepgram(greetingText);

        // Stream the synthesized audio to Twilio.
        await streamAIResponseToTwilio(ws, aiAudioBuffer, streamSid, callSid);
    }

    // Start the server.
    const PORT = process.env.PORT || 8080;
    server.listen(PORT, () => {
        console.log(`Listening at Port ${PORT}`);
    });
})();
