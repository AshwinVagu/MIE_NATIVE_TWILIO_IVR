
// Ensure global.Headers is defined for node-fetch compatibility if needed
(async () => {
   if (typeof global.Headers === 'undefined') {
       const fetch = await import('node-fetch');
       global.Headers = fetch.Headers;
   }


   // Required Node.js modules
   const WebSocket = require("ws");
   const express = require("express");
   const WaveFile = require("wavefile").WaveFile;
   const axios = require("axios");
   const { GoogleGenAI, Modality } = require('@google/genai');
   require("dotenv").config();


   // Initialize Express application and WebSocket server
   const app = express();
   const server = require("http").createServer(app);
   const wss = new WebSocket.Server({ server });


   // API keys
   const GEMINI_API_KEY = process.env.GEMINI_API_KEY || "";
   const DEEPGRAM_API_KEY = process.env.DEEPGRAM_API_KEY;


   // Check API keys
   if (!GEMINI_API_KEY) {
       console.error("GEMINI_API_KEY is required for Live API.");
       process.exit(1);
   }
   if (!DEEPGRAM_API_KEY) {
       console.error("DEEPGRAM_API_KEY is required for TTS fallback.");
       process.exit(1);
   }


   // Initialize Gemini AI
   const ai = new GoogleGenAI({ apiKey: GEMINI_API_KEY });


   // Global state management
   let conversationHistory = {};
   let incomingAudioBuffers = {};
   let timeoutHandlers = {};
   let speakingState = {};
   let streamSidToCallSidMap = {};
   let geminiSessions = {}; // Store Live API sessions per call
   let audioResponseQueues = {}; // Queue for audio responses


   // --- Audio Utility Functions ---


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


   // --- Gemini Live API Functions ---


   /**
    * Initialize a Gemini Live API session for a call
    */
   async function initializeGeminiSession(callSid) {
       try {
           console.log(`[${callSid}] Initializing Gemini Live API session...`);


           // Use the live model - this is crucial!
           const model = "gemini-2.5-flash-preview-native-audio-dialog";
          
           const config = {
               responseModalities: [Modality.TEXT], // Start with text only for debugging
               systemInstruction: `
                   You are an intelligent IVR assistant for a hospital. Your goal is to assist callers by providing accurate information about the hospital, including operational hours, address, and general guidance.


                   You should always respond in a **polite and professional tone**, ensuring clarity in communication.


                   **Key Instructions:**
                   1. If a caller asks about hospital hours, state the operating hours from **Monday to Friday** and inform them that the hospital is closed on **Saturday and Sunday**. The hospital operates from **8:00 AM to 6:00 PM**.
                   2. If a caller requests the hospital's address, provide the full address in a clear format: "Our hospital is located at: MediCare General Hospital, 1234 Wellness Avenue, Springfield, IL, 62704, USA."
                   3. If a caller asks about both the **timings and address**, provide both details in a well-structured response.
                   4. Ensure responses are **concise, yet complete**, to avoid confusion for the caller.
                   5. If the caller asks a question that you **do not have an answer for**, kindly inform them that they can reach the hospital directly for further inquiries.
                   6. After giving a caller a complete answer, ask the callers if they have any more questions.
                   7. If the caller has no more questions or indicates they are done, end the conversation politely and ask the user to hang up the phone call.


                   Keep responses short and natural for voice conversation.
               `,
               generationConfig: {
                   temperature: 0.7,
                   maxOutputTokens: 150
               }
           };


           // Initialize response queue for this call
           audioResponseQueues[callSid] = [];


           console.log(`[${callSid}] Connecting to Gemini Live API...`);


           const session = await ai.live.connect({
               model: model,
               callbacks: {
                   onopen: function () {
                       console.log(`[${callSid}] Gemini Live session opened successfully`);
                   },
                   onmessage: function (message) {
                       console.log(`[${callSid}] Received message from Gemini`);
                       handleGeminiResponse(message, callSid);
                   },
                   onerror: function (e) {
                       console.error(`[${callSid}] Gemini Live error:`, e);
                   },
                   onclose: function (e) {
                       console.log(`[${callSid}] Gemini Live session closed:`, e.reason);
                   },
               },
               config: config,
           });


           geminiSessions[callSid] = session;
           console.log(`[${callSid}] Gemini Live session initialized and stored`);
          
           // Test the connection with a simple message
           setTimeout(() => {
               console.log(`[${callSid}] Testing Gemini connection...`);
               session.sendRealtimeInput({
                   text: "Hello, can you confirm you're ready to assist hospital callers?"
               });
           }, 1000);
          
           return session;
       } catch (error) {
           console.error(`[${callSid}] Error initializing Gemini Live session:`, error);
           return null;
       }
   }


   /**
    * Handle responses from Gemini Live API
    */
   function handleGeminiResponse(message, callSid) {
       console.log(`[${callSid}] Received Gemini message:`, JSON.stringify(message, null, 2));
      
       audioResponseQueues[callSid].push(message);
      
       // Check if this is a complete turn
       if (message.serverContent && message.serverContent.turnComplete) {
           console.log(`[${callSid}] Gemini turn complete, processing response...`);
           processGeminiTurn(callSid);
       }
      
       // Also check for individual audio/text parts
       if (message.serverContent && message.serverContent.modelTurn) {
           console.log(`[${callSid}] Received model turn with parts:`, message.serverContent.modelTurn.parts);
       }
   }


   /**
    * Process a complete turn from Gemini
    */
   async function processGeminiTurn(callSid) {
       const messages = audioResponseQueues[callSid];
       audioResponseQueues[callSid] = []; // Clear the queue


       console.log(`[${callSid}] Processing ${messages.length} messages from Gemini turn`);


       if (messages.length === 0) return;


       // Extract text response for logging and TTS
       let textResponse = '';
       let hasAudio = false;
       const combinedAudio = [];


       for (const message of messages) {
           // Check for text content
           if (message.serverContent && message.serverContent.modelTurn && message.serverContent.modelTurn.parts) {
               for (const part of message.serverContent.modelTurn.parts) {
                   if (part.text) {
                       textResponse += part.text;
                   }
               }
           }


           // Check for audio content
           if (message.data) {
               hasAudio = true;
               const buffer = Buffer.from(message.data, 'base64');
               const intArray = new Int16Array(buffer.buffer, buffer.byteOffset, buffer.byteLength / Int16Array.BYTES_PER_ELEMENT);
               combinedAudio.push(...Array.from(intArray));
           }
       }


       console.log(`[${callSid}] Extracted text: "${textResponse}"`);
       console.log(`[${callSid}] Has audio: ${hasAudio}, Audio samples: ${combinedAudio.length}`);


       if (textResponse) {
           // Update conversation history
           conversationHistory[callSid].push({
               role: "assistant",
               content: textResponse
           });


           // Convert text to speech using Deepgram since we're starting with text-only mode
           try {
               console.log(`[${callSid}] Converting text to speech: "${textResponse}"`);
              
               const response = await axios.post(
                   "https://api.deepgram.com/v1/speak?model=aura-asteria-en&encoding=linear16&sample_rate=8000",
                   { text: textResponse },
                   {
                       headers: {
                           Authorization: `Token ${DEEPGRAM_API_KEY}`,
                           "Content-Type": "application/json"
                       },
                       responseType: "arraybuffer"
                   }
               );
              
               const aiAudioBuffer = Buffer.from(response.data);
              
               // Stream to Twilio
               const streamSid = Object.keys(streamSidToCallSidMap).find(key => streamSidToCallSidMap[key] === callSid);
               if (streamSid) {
                   const ws = getWebSocketForCall(callSid);
                   if (ws) {
                       console.log(`[${callSid}] Streaming TTS audio to Twilio`);
                       await streamAIResponseToTwilio(ws, aiAudioBuffer, streamSid, callSid);
                   } else {
                       console.error(`[${callSid}] No WebSocket found for call`);
                   }
               } else {
                   console.error(`[${callSid}] No stream SID found for call`);
               }
              
           } catch (ttsError) {
               console.error(`[${callSid}] TTS error:`, ttsError);
           }
       }


       // Handle native audio if available (for future use when we enable audio mode)
       if (hasAudio && combinedAudio.length > 0) {
           console.log(`[${callSid}] Processing native audio response`);
           const audioBuffer = new Int16Array(combinedAudio);
          
           // Convert from 24kHz (Gemini output) to 8kHz (Twilio)
           const downsampledAudio = downsampleAudio(audioBuffer, 24000, 8000);
           const pcmBuffer = Buffer.from(downsampledAudio.buffer);
          
           // Stream to Twilio
           const streamSid = Object.keys(streamSidToCallSidMap).find(key => streamSidToCallSidMap[key] === callSid);
           if (streamSid) {
               const ws = getWebSocketForCall(callSid);
               if (ws) {
                   await streamAIResponseToTwilio(ws, pcmBuffer, streamSid, callSid);
               }
           }
       }
   }


   /**
    * Send audio to Gemini Live API
    */
   async function sendAudioToGemini(audioBuffer, callSid) {
       const session = geminiSessions[callSid];
       if (!session) {
           console.error(`[${callSid}] No Gemini session available`);
           return;
       }


       try {
           // For debugging, let's also try sending text first
           console.log(`[${callSid}] Sending test text to Gemini...`);
           session.sendRealtimeInput({
               text: "User said something, please respond with: I heard you speak. What can I help you with?"
           });


           // Also send the audio
           // Convert 8kHz audio to 16kHz for Gemini
           const upsampledAudio = upsampleAudio(audioBuffer, 8000, 16000);
           const base64Audio = Buffer.from(upsampledAudio.buffer).toString('base64');


           console.log(`[${callSid}] Sending ${audioBuffer.length} bytes audio to Gemini Live API (upsampled to ${upsampledAudio.length * 2} bytes)`);


           session.sendRealtimeInput({
               audio: {
                   data: base64Audio,
                   mimeType: "audio/pcm;rate=16000"
               }
           });


           console.log(`[${callSid}] Audio sent successfully to Gemini`);


       } catch (error) {
           console.error(`[${callSid}] Error sending audio to Gemini:`, error);
       }
   }


   /**
    * Simple audio resampling functions
    */
   function upsampleAudio(audioBuffer, fromRate, toRate) {
       const ratio = toRate / fromRate;
       const inputSamples = new Int16Array(audioBuffer.buffer, audioBuffer.byteOffset, audioBuffer.byteLength / 2);
       const outputLength = Math.floor(inputSamples.length * ratio);
       const outputSamples = new Int16Array(outputLength);


       for (let i = 0; i < outputLength; i++) {
           const inputIndex = i / ratio;
           const inputIndexFloor = Math.floor(inputIndex);
           outputSamples[i] = inputSamples[Math.min(inputIndexFloor, inputSamples.length - 1)];
       }


       return outputSamples;
   }


   function downsampleAudio(audioBuffer, fromRate, toRate) {
       const ratio = toRate / fromRate;
       const outputLength = Math.floor(audioBuffer.length * ratio);
       const outputSamples = new Int16Array(outputLength);


       for (let i = 0; i < outputLength; i++) {
           const inputIndex = Math.floor(i / ratio);
           outputSamples[i] = audioBuffer[Math.min(inputIndex, audioBuffer.length - 1)];
       }


       return outputSamples;
   }


   // Store WebSocket connections per call for reference
   let callWebSockets = {};


   function getWebSocketForCall(callSid) {
       return callWebSockets[callSid];
   }


   /**
    * Stream AI response to Twilio (same as before)
    */
   async function streamAIResponseToTwilio(ws, aiAudioBuffer, streamSid, callSid) {
       try {
           if (!aiAudioBuffer || !ws) {
               console.warn(`[${callSid}] No audio buffer or WebSocket provided`);
               return;
           }


           speakingState[callSid] = true;


           const muLawBuffer = pcmToMuLaw(aiAudioBuffer);
           const audioChunks = chunkBuffer(muLawBuffer, 160);


           console.log(`[${callSid}] Streaming audio in ${audioChunks.length} chunks...`);


           for (let i = 0; i < audioChunks.length; i++) {
               const chunk = audioChunks[i];
              
               if (!speakingState[callSid] || ws.readyState !== WebSocket.OPEN) {
                   console.log(`[${callSid}] Audio streaming interrupted`);
                   break;
               }


               const payload = chunk.toString('base64');
               ws.send(JSON.stringify({ event: "media", streamSid, media: { payload } }));


               await new Promise(resolve => setTimeout(resolve, 20));
           }


           if (ws.readyState === WebSocket.OPEN && speakingState[callSid]) {
               ws.send(JSON.stringify({ event: "mark", streamSid, mark: { name: "tts_response_end" } }));
           }


           speakingState[callSid] = false;


       } catch (err) {
           console.error(`[${callSid}] Error streaming AI response:`, err);
           speakingState[callSid] = false;
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
           let callSid;
           let streamSid = msg.streamSid;


           switch (msg.event) {
               case "connected":
                   console.log(`Call connected! Call SID: ${msg.callSid}`);
                   break;


               case "start":
                   console.log("Twilio call connected");
                   callSid = msg.start.callSid;
                   streamSid = msg.streamSid;


                   streamSidToCallSidMap[streamSid] = callSid;
                   callWebSockets[callSid] = ws; // Store WebSocket reference


                   console.log(`[${callSid}] Call SID: ${callSid}, Stream SID: ${streamSid}`);


                   // Initialize state
                   conversationHistory[callSid] = [];
                   incomingAudioBuffers[callSid] = Buffer.alloc(0);
                   speakingState[callSid] = false;


                   // Initialize Gemini Live session
                   await initializeGeminiSession(callSid);


                   // Send greeting
                   await greetingMessage(ws, streamSid, callSid);
                   break;


               case "media":
                   callSid = streamSidToCallSidMap[streamSid];


                   if (!callSid) {
                       console.error(`Call SID not found for stream SID: ${streamSid}`);
                       return;
                   }


                   const twilioData = msg.media.payload;


                   if (typeof twilioData !== 'string' || twilioData.length === 0) {
                       console.warn(`[${callSid}] Invalid media payload`);
                       return;
                   }


                   try {
                       // Convert Mu-Law to Linear16 PCM
                       const wav = new WaveFile();
                       wav.fromScratch(1, 8000, "8m", Buffer.from(twilioData, "base64"));
                       wav.fromMuLaw();
                       const audioBufferLinear16 = Buffer.from(wav.data.samples);


                       if (isSilent(audioBufferLinear16)) {
                           return;
                       }


                       // Append to buffer
                       incomingAudioBuffers[callSid] = Buffer.concat([incomingAudioBuffers[callSid], audioBufferLinear16]);


                       // Clear existing timer
                       if (timeoutHandlers[callSid]) {
                           clearTimeout(timeoutHandlers[callSid]);
                       }


                       // Set new timer for end of speech detection
                       timeoutHandlers[callSid] = setTimeout(async () => {
                           console.log(`[${callSid}] Processing audio with Gemini Live API`);


                           const currentAudioSegment = incomingAudioBuffers[callSid];
                           incomingAudioBuffers[callSid] = Buffer.alloc(0);


                           if (currentAudioSegment.length > 8000) { // At least 0.5 seconds
                               // Handle barge-in
                               if (speakingState[callSid]) {
                                   console.log(`[${callSid}] Barge-in detected, interrupting AI speech`);
                                   speakingState[callSid] = false;
                               }


                               // Send to Gemini Live API
                               await sendAudioToGemini(currentAudioSegment, callSid);
                           }
                       }, 700);


                   } catch (audioConversionError) {
                       console.error(`[${callSid}] Audio conversion error:`, audioConversionError.message);
                       return;
                   }
                   break;


               case "mark":
                   callSid = streamSidToCallSidMap[streamSid];
                   if (!callSid) return;


                   if (msg.mark.name === "tts_response_end") {
                       speakingState[callSid] = false;
                       console.log(`[${callSid}] AI finished speaking`);
                   }
                   break;


               case "stop":
                   callSid = streamSidToCallSidMap[streamSid];
                   if (!callSid) return;


                   console.log(`[${callSid}] Call ended`);


                   // Clean up Gemini session
                   if (geminiSessions[callSid]) {
                       geminiSessions[callSid].close();
                       delete geminiSessions[callSid];
                   }


                   // Clean up all state
                   if (timeoutHandlers[callSid]) {
                       clearTimeout(timeoutHandlers[callSid]);
                   }
                   delete conversationHistory[callSid];
                   delete incomingAudioBuffers[callSid];
                   delete timeoutHandlers[callSid];
                   delete speakingState[callSid];
                   delete audioResponseQueues[callSid];
                   delete callWebSockets[callSid];
                   delete streamSidToCallSidMap[streamSid];
                   break;
           }
       });


       ws.on("error", (error) => {
           console.error("Twilio WebSocket error:", error);
       });


       ws.on("close", () => {
           console.log("Twilio WebSocket closed");
       });
   });


   // --- HTTP Endpoint for Twilio Webhook ---


   app.post("/", async (req, res) => {
       res.set("Content-Type", "text/xml");
       res.send(
           `<Response>
               <Connect>
                   <Stream url='wss://${req.headers.host}' />
               </Connect>
           </Response>`
       );
       console.log("Sent TwiML response to Twilio");
   });


   // --- Greeting Message Function ---


   async function greetingMessage(ws, streamSid, callSid) {
       const greetingText = "Welcome to MediCare General Hospital automated assistant. How may I help you today?";
      
       if (!conversationHistory[callSid]) {
           conversationHistory[callSid] = [];
       }
       conversationHistory[callSid].push({ role: "assistant", content: greetingText });


       // For greeting, we can use text-to-speech since Gemini Live session might not be ready
       try {
           const response = await axios.post(
               "https://api.deepgram.com/v1/speak?model=aura-asteria-en&encoding=linear16&sample_rate=8000",
               { text: greetingText },
               {
                   headers: {
                       Authorization: `Token ${DEEPGRAM_API_KEY}`,
                       "Content-Type": "application/json"
                   },
                   responseType: "arraybuffer"
               }
           );
           const aiAudioBuffer = Buffer.from(response.data);
           await streamAIResponseToTwilio(ws, aiAudioBuffer, streamSid, callSid);
       } catch (error) {
           console.error(`[${callSid}] Error generating greeting:`, error);
       }
   }


   // Start the server
   const PORT = process.env.PORT || 8080;
   server.listen(PORT, () => {
       console.log(`Server listening on Port ${PORT}`);
   });
})();
