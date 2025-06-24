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
   // NEW: Track last activity time for better silence detection
   let lastActivityTime = {};
   // NEW: Track audio quality metrics
   let audioQualityMetrics = {};


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


   /**
    * Converts raw PCM audio buffer to proper WAV format with headers
    * @param {Buffer} pcmBuffer - Raw PCM audio data
    * @param {number} sampleRate - Sample rate (default 8000 for Twilio)
    * @param {number} channels - Number of channels (default 1 for mono)
    * @param {number} bitsPerSample - Bits per sample (default 16)
    * @returns {Buffer} - WAV formatted audio buffer
    */
   function pcmToWav(pcmBuffer, sampleRate = 8000, channels = 1, bitsPerSample = 16) {
       const blockAlign = channels * bitsPerSample / 8;
       const byteRate = sampleRate * blockAlign;
       const dataSize = pcmBuffer.length;
       const fileSize = 36 + dataSize;


       const header = Buffer.alloc(44);
       let offset = 0;


       // RIFF header
       header.write('RIFF', offset); offset += 4;
       header.writeUInt32LE(fileSize, offset); offset += 4;
       header.write('WAVE', offset); offset += 4;


       // fmt chunk
       header.write('fmt ', offset); offset += 4;
       header.writeUInt32LE(16, offset); offset += 4; // chunk size
       header.writeUInt16LE(1, offset); offset += 2; // PCM format
       header.writeUInt16LE(channels, offset); offset += 2;
       header.writeUInt32LE(sampleRate, offset); offset += 4;
       header.writeUInt32LE(byteRate, offset); offset += 4;
       header.writeUInt16LE(blockAlign, offset); offset += 2;
       header.writeUInt16LE(bitsPerSample, offset); offset += 2;


       // data chunk
       header.write('data', offset); offset += 4;
       header.writeUInt32LE(dataSize, offset);


       return Buffer.concat([header, pcmBuffer]);
   }


   /**
    * IMPROVED: Better silence detection with adaptive thresholds and RMS calculation
    * @param {Buffer} buffer - Audio buffer to analyze
    * @param {string} callSid - Call ID for tracking adaptive thresholds
    * @returns {boolean} - True if audio is considered silent
    */
   function isSilent(buffer, callSid) {
       if (buffer.length < 2) return true;
      
       // Initialize quality metrics for this call if not exists
       if (!audioQualityMetrics[callSid]) {
           audioQualityMetrics[callSid] = {
               avgAmplitude: 0,
               maxAmplitude: 0,
               sampleCount: 0,
               adaptiveThreshold: 800 // Start with lower threshold
           };
       }


       const metrics = audioQualityMetrics[callSid];
      
       // Calculate RMS (Root Mean Square) for better audio level detection
       let sumSquares = 0;
       let maxSample = 0;
       const sampleCount = buffer.length / 2;
      
       for (let i = 0; i < buffer.length; i += 2) {
           const sample = Math.abs(buffer.readInt16LE(i));
           sumSquares += sample * sample;
           maxSample = Math.max(maxSample, sample);
       }
      
       const rms = Math.sqrt(sumSquares / sampleCount);
      
       // Update adaptive threshold based on recent audio levels
       metrics.avgAmplitude = (metrics.avgAmplitude * 0.95) + (rms * 0.05);
       metrics.maxAmplitude = Math.max(metrics.maxAmplitude, maxSample);
       metrics.sampleCount++;
      
       // Adaptive threshold: use 20% of average amplitude, with bounds
       metrics.adaptiveThreshold = Math.max(200, Math.min(2000, metrics.avgAmplitude * 0.2));
      
       const isSilentResult = rms < metrics.adaptiveThreshold;
      
       // Log for debugging
       if (metrics.sampleCount % 100 === 0) {
           console.log(`Audio Quality [${callSid}]: RMS=${rms.toFixed(0)}, Threshold=${metrics.adaptiveThreshold.toFixed(0)}, Avg=${metrics.avgAmplitude.toFixed(0)}`);
       }
      
       return isSilentResult;
   }


   /**
    * NEW: Validates audio buffer quality and continuity
    * @param {Buffer} buffer - Audio buffer to validate
    * @param {string} callSid - Call ID for logging
    * @returns {boolean} - True if audio quality is acceptable
    */
   function validateAudioQuality(buffer, callSid) {
       if (!buffer || buffer.length < 1600) { // Less than 100ms at 8kHz 16-bit
           console.log(`[${callSid}] Audio too short: ${buffer?.length || 0} bytes`);
           return false;
       }
      
       // Check for completely zero audio (connection issues)
       let nonZeroSamples = 0;
       for (let i = 0; i < Math.min(buffer.length, 3200); i += 2) { // Check first 200ms
           if (buffer.readInt16LE(i) !== 0) {
               nonZeroSamples++;
           }
       }
      
       const nonZeroRatio = nonZeroSamples / (Math.min(buffer.length, 3200) / 2);
       if (nonZeroRatio < 0.1) {
           console.log(`[${callSid}] Audio mostly silent/corrupted: ${(nonZeroRatio * 100).toFixed(1)}% non-zero`);
           return false;
       }
      
       return true;
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
           // Validate audio quality before processing
           if (!validateAudioQuality(audioBuffer, callSid)) {
               console.log(`[${callSid}] Skipping Gemini call due to poor audio quality`);
               return ""; // Return empty string for poor quality audio
           }


           // Encode the audio buffer to Base64 for inline data in the Gemini request.
           const wavBuffer = pcmToWav(audioBuffer, 8000, 1, 16);
           const base64Audio = wavBuffer.toString('base64');
           console.log(`[${callSid}] Sending ${audioBuffer.length} bytes of audio to Gemini (WAV: ${wavBuffer.length} bytes).`);
          
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


               **IMPORTANT: Only respond if you can clearly understand speech in the audio. If the audio is unclear, contains only noise, or you cannot make out words, respond with an empty string.**


               Example Responses:


               **For Hospital Timings Inquiry:**
               "The hospital operates from Monday to Friday, between 8:00 AM and 6:00 PM. Please note that we are closed on Saturdays and Sundays. Do you have any more questions?"


               **For Hospital Address Inquiry:**
               "Our hospital is located at: MediCare General Hospital, 1234 Wellness Avenue, Springfield, IL, 62704, USA. Is there anything else I can help you with?"


               **For Both Timings and Address Inquiry:**
               "Thank you for contacting MediCare General Hospital. Our operating hours are Monday to Friday from 8:00 AM to 6:00 PM. We remain closed on Saturdays and Sundays. You can visit us at: MediCare General Hospital, 1234 Wellness Avenue, Springfield, IL, 62704, USA. If you need any further assistance, feel free to contact our front desk."


               Ensure that all responses are **formatted clearly**, so the caller can easily understand the details.
           `;


           // Build the contents array with proper structure
           const payloadContents = [];
          
           // Add system instruction as the first message if this is the start of conversation
           if (historyForGemini.length === 0) {
               payloadContents.push({
                   role: "user",
                   parts: [{ text: systemPrompt }]
               });
               payloadContents.push({
                   role: "model",
                   parts: [{ text: "I understand. I'm ready to assist callers as a professional hospital IVR assistant." }]
               });
           }
          
           // Add conversation history
           payloadContents.push(...historyForGemini);
          
           // Add current audio input with corrected format
           payloadContents.push({
               role: "user",
               parts: [
                   {
                       inlineData: {
                           mimeType: "audio/wav",
                           data: base64Audio
                       }
                   }
               ]
           });


           const apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${GEMINI_API_KEY}`;
           console.log(`[${callSid}] Calling Gemini API...`);


           const response = await axios.post(
               apiUrl,
               {
                   contents: payloadContents,
                   generationConfig: {
                       temperature: 0.7,
                       maxOutputTokens: 150, // Keep responses concise for voice
                   }
               },
               {
                   headers: {
                       'Content-Type': 'application/json'
                   },
                   timeout: 10000 // 10 second timeout
               }
           );


           // Parse the response. Gemini returns a JSON object with text content.
           const responseData = response.data;


           if (responseData.candidates && responseData.candidates.length > 0 && responseData.candidates[0].content && responseData.candidates[0].content.parts && responseData.candidates[0].content.parts.length > 0) {
               const generatedText = responseData.candidates[0].content.parts[0].text;
               console.log(`[${callSid}] Received text response from Gemini: "${generatedText.trim()}"`);
               return generatedText.trim();
           } else {
               console.error(`[${callSid}] Unexpected Gemini response structure:`, JSON.stringify(responseData, null, 2));
               return "I'm sorry, I couldn't process your request or generate a text response from Gemini.";
           }


       } catch (error) {
           console.error(`[${callSid}] Error calling Gemini API:`, error.response ? error.response.data : error.message);
          
           // More specific error handling
           if (error.response && error.response.data && error.response.data.error) {
               const geminiError = error.response.data.error;
               console.error(`[${callSid}] Gemini API Error Details:`, {
                   code: geminiError.code,
                   message: geminiError.message,
                   status: geminiError.status
               });
           }
          
           return "I'm sorry, I encountered an error while processing your request with Gemini.";
       }
   }


   const fs = require('fs');
   const path = require('path');
  
   // Method 1: Save audio files for manual inspection
   function saveAudioForDebugging(audioBuffer, callSid, timestamp) {
       try {
           // Create debug directory if it doesn't exist
           const debugDir = path.join(__dirname, 'debug_audio');
           if (!fs.existsSync(debugDir)) {
               fs.mkdirSync(debugDir);
           }


           // Save raw PCM
           const pcmFilename = `${callSid}_${timestamp}_raw.pcm`;
           const pcmPath = path.join(debugDir, pcmFilename);
           fs.writeFileSync(pcmPath, audioBuffer);


           // Save as WAV for easy playback
           const wavBuffer = pcmToWav(audioBuffer, 8000, 1, 16);
           const wavFilename = `${callSid}_${timestamp}_audio.wav`;
           const wavPath = path.join(debugDir, wavFilename);
           fs.writeFileSync(wavPath, wavBuffer);


           console.log(`[${callSid}] Audio saved: ${wavFilename} (${audioBuffer.length} bytes PCM, ${wavBuffer.length} bytes WAV)`);
          
           return { pcmPath, wavPath };
       } catch (error) {
           console.error(`[${callSid}] Error saving debug audio:`, error);
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
               console.warn(`[${callSid}] No AI audio buffer provided to stream.`);
               return;
           }


           // Set speaking state to true to prevent barge-in during AI speech.
           speakingState[callSid] = true;


           // Convert Linear16 PCM to Mu-Law for Twilio streaming.
           const muLawBuffer = pcmToMuLaw(aiAudioBuffer);
           const audioChunks = chunkBuffer(muLawBuffer, 160); // 160 bytes = 20ms at 8kHz Mu-Law


           console.log(`[${callSid}] Streaming TTS audio in ${audioChunks.length} chunks...`);


           for (let i = 0; i < audioChunks.length; i++) {
               const chunk = audioChunks[i];
               // Check if barge-in occurred or WebSocket is closed before sending each chunk.
               if (!speakingState[callSid] || ws.readyState !== WebSocket.OPEN) {
                   console.log(`[${callSid}] TTS interrupted by user speech or WebSocket closed.`);
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
           console.error(`[${callSid}] Error streaming AI response:`, err);
           speakingState[callSid] = false; // Ensure speaking state is reset on error
       }
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
                   console.log(`Call connected! Call SID: ${msg.callSid}`);
                   break;


               case "start":
                   console.log("Twilio call connected with msg:", msg);
                   callSid = msg.start.callSid; // CallSid comes from msg.start for 'start' event
                   streamSid = msg.streamSid; // streamSid is direct on msg for 'start' event


                   // Store the mapping from streamSid to callSid
                   streamSidToCallSidMap[streamSid] = callSid;


                   console.log(`[${callSid}] Call SID: ${callSid}, Stream SID: ${streamSid}`);


                   // Initialize state for the new call using callSid.
                   conversationHistory[callSid] = [];
                   incomingAudioBuffers[callSid] = Buffer.alloc(0); // Initialize an empty buffer for incoming audio
                   speakingState[callSid] = false; // AI is not speaking initially (before greeting)
                   lastActivityTime[callSid] = Date.now();
                   audioQualityMetrics[callSid] = {
                       avgAmplitude: 0,
                       maxAmplitude: 0,
                       sampleCount: 0,
                       adaptiveThreshold: 800
                   };
                  
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
                   const twilioData = msg.media.payload;
                  
                   if (typeof twilioData !== 'string' || twilioData.length === 0) {
                       console.warn(`[${callSid}] Received invalid type or empty media payload. Skipping.`);
                       return;
                   }


                   // Convert Mu-Law to Linear16 PCM
                   try {
                       const wav = new WaveFile();
                       wav.fromScratch(1, 8000, "8m", Buffer.from(twilioData, "base64")); // From Mu-Law 8kHz
                       wav.fromMuLaw(); // Convert internal samples to Linear16
                       const audioBufferLinear16 = Buffer.from(wav.data.samples); // Extract Linear16 PCM data


                       // Update last activity time
                       lastActivityTime[callSid] = Date.now();


                       // IMPROVED: Use enhanced silence detection
                       if (isSilent(audioBufferLinear16, callSid)) {
                           return; // Skip processing silence
                       }


                       // Append the current audio chunk to the accumulated buffer for this call.
                       incomingAudioBuffers[callSid] = Buffer.concat([incomingAudioBuffers[callSid], audioBufferLinear16]);


                       // Clear any existing inactivity timer as user is still speaking.
                       if (timeoutHandlers[callSid]) {
                           clearTimeout(timeoutHandlers[callSid]);
                       }


                       // IMPROVED: Longer timeout for more complete sentences, with minimum buffer size check
                       timeoutHandlers[callSid] = setTimeout(async () => {
                           console.log(`[${callSid}] User speech timeout triggered. Processing audio segment.`);


                           const currentAudioSegment = incomingAudioBuffers[callSid];
                           incomingAudioBuffers[callSid] = Buffer.alloc(0); // Clear the buffer for the next segment.
                          
                           console.log(`[${callSid}] Processing audio segment of length: ${currentAudioSegment.length} bytes`);


                           // IMPROVED: Only process if we have substantial audio (at least 0.5 seconds)
                           if (currentAudioSegment.length > 8000) { // 0.5 seconds at 8kHz 16-bit = 8000 bytes
                               const {pcmPath, wavPath} = saveAudioForDebugging(currentAudioSegment, callSid, Date.now());
                              
                               // Call Gemini with the accumulated audio to get a text response.
                               const aiTextResponse = await geminiGenerateContent(currentAudioSegment, callSid);


                               // IMPROVED: Only proceed if we got a meaningful response
                               if (aiTextResponse && aiTextResponse.length > 0) {
                                   // --- Refined Barge-in logic ---
                                   if (speakingState[callSid]) {
                                       console.log(`[${callSid}] Confirmed barge-in by meaningful user speech. Interrupting AI speech.`);
                                       speakingState[callSid] = false; // This will stop current AI streaming
                                   }


                                   // Update conversation history with meaningful responses only
                                   conversationHistory[callSid].push({ role: "user", content: `User said: ${aiTextResponse}` });
                                   conversationHistory[callSid].push({ role: "assistant", content: aiTextResponse });
                                   console.log(`[${callSid}] AI Text Response: "${aiTextResponse}"`);


                                   // Only synthesize and stream if not currently speaking
                                   if (!speakingState[callSid]) {
                                       try {
                                           // Synthesize the AI's text response into audio using Deepgram TTS.
                                           const aiAudioBuffer = await synthesizeWithDeepgram(aiTextResponse);


                                           // Stream the synthesized audio back to Twilio.
                                           await streamAIResponseToTwilio(ws, aiAudioBuffer, streamSid, callSid);
                                       } catch (ttsError) {
                                           console.error(`[${callSid}] TTS synthesis failed:`, ttsError);
                                       }
                                   } else {
                                       console.log(`[${callSid}] AI was speaking and meaningful user speech detected. Skipping new AI response.`);
                                   }
                               } else {
                                   console.log(`[${callSid}] No meaningful speech detected from Gemini response.`);
                               }
                           } else {
                               console.log(`[${callSid}] Audio segment too short (${currentAudioSegment.length} bytes), waiting for more audio.`);
                           }
                       }, 1200); // IMPROVED: Increased timeout to 1.2 seconds for more complete sentences


                   } catch (audioConversionError) {
                       console.error(`[${callSid}] Error during audio conversion (Mu-Law to Linear16):`, audioConversionError.message);
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
                   if (msg.mark.name === "tts_response_end") {
                       speakingState[callSid] = false;
                       console.log(`[${callSid}] AI finished speaking and mark received.`);
                   }
                   break;


               case "stop":
                   // Retrieve callSid from the map using streamSid
                   callSid = streamSidToCallSidMap[streamSid];
                   if (!callSid) {
                       console.error(`Call SID not found for stream SID: ${streamSid}. Cannot stop processing.`);
                   } else {
                       console.log(`[${callSid}] Call ended for SID: ${callSid}`);
                       // Clean up resources associated with the ended call.
                       if (timeoutHandlers[callSid]) {
                           clearTimeout(timeoutHandlers[callSid]);
                       }
                       delete conversationHistory[callSid];
                       delete incomingAudioBuffers[callSid];
                       delete timeoutHandlers[callSid];
                       delete speakingState[callSid];
                       delete lastActivityTime[callSid];
                       delete audioQualityMetrics[callSid];
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
       const greetingText = "Welcome to MediCare General Hospital automated assistant. How may I help you today?";
      
       // Make sure conversationHistory[callSid] is initialized before pushing to it.
       if (!conversationHistory[callSid]) {
            conversationHistory[callSid] = [];
       }
       conversationHistory[callSid].push({ role: "assistant", content: greetingText });


       try {
           // Synthesize the greeting text using Deepgram TTS.
           const aiAudioBuffer = await synthesizeWithDeepgram(greetingText);


           // Stream the synthesized audio to Twilio.
           await streamAIResponseToTwilio(ws, aiAudioBuffer, streamSid, callSid);
       } catch (error) {
           console.error(`[${callSid}] Error generating greeting:`, error);
       }
   }


   // Start the server.
   const PORT = process.env.PORT || 8080;
   server.listen(PORT, () => {
       console.log(`Server listening on Port ${PORT}`);
   });
})();
