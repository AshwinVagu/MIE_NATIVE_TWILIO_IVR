/**
 * Voice-to-Voice Chat with Gemini 2.0 Flash Live API
 * 
 * This script creates a real-time voice conversation with Gemini AI using the Live API.
 * It captures your voice from the microphone, sends it to Gemini via WebSocket, 
 * and plays Gemini's voice responses through speakers.
 * 
 * Dependencies:
 * - @google/genai (latest version with Live API support)
 * - mic
 * - speaker
 * 
 * Setup:
 * 1. Install dependencies: npm install @google/genai mic speaker
 * 2. Set GOOGLE_API_KEY environment variable with your API key from Google AI Studio
 * 
 * Usage:
 * 1. Run the script: node voice_chat.js
 * 2. Start speaking into your microphone
 * 3. Listen to Gemini's responses
 * 4. Press Ctrl+C to exit
 * 
 * Note: Headphones are recommended to prevent audio feedback
 */

import { GoogleGenAI } from '@google/genai';
import mic from 'mic';
import Speaker from 'speaker';
import { EventEmitter } from 'events';

// Check Node.js version (require 16+ for good async support)
const nodeVersion = process.version.match(/^v(\d+\.\d+)/)[1];
if (parseFloat(nodeVersion) < 16.0) {
    console.error('Error: This script requires Node.js 16.0 or newer.');
    console.error('Please upgrade your Node.js installation.');
    process.exit(1);
}

// Audio configuration
const CHANNELS = 1;
const SEND_SAMPLE_RATE = 16000;     // Microphone input rate (Live API requirement)
const RECEIVE_SAMPLE_RATE = 24000;  // Gemini output rate (Live API specification)
const SILENCE_THRESHOLD = 1500;     // ms of silence before ending speech

class AudioLoop extends EventEmitter {
    constructor() {
        super();
        this.audioInQueue = [];
        this.session = null;
        this.micInstance = null;
        this.micInputStream = null;
        this.speaker = null;
        this.isRecording = false;
        this.isSpeaking = false;
        this.silenceTimer = null;
        this.audioBuffer = [];
        this.genAI = null;
    }

    async initialize() {
        try {
            // Initialize Google AI client
            const apiKey = "API_Key";
            if (!apiKey) {
                throw new Error('GOOGLE_API_KEY environment variable is required');
            }
            
            this.genAI = new GoogleGenAI({
                apiKey: apiKey
            });

            // Initialize speaker for audio output
            this.speaker = new Speaker({
                channels: CHANNELS,
                bitDepth: 16,
                sampleRate: RECEIVE_SAMPLE_RATE,
            });

            console.log('Voice chat initialized. Starting Live API session...');
            await this.startSession();
            
        } catch (error) {
            console.error('Failed to initialize:', error.message);
            process.exit(1);
        }
    }

    async startSession() {
        try {
            const model = "gemini-2.0-flash-live-001";
            const config = {
                responseModalities: ["AUDIO"],
                // Enable voice activity detection
                realtimeInputConfig: {
                    automaticActivityDetection: {
                        disabled: false,
                        startOfSpeechSensitivity: "START_SENSITIVITY_MEDIUM",
                        endOfSpeechSensitivity: "END_SENSITIVITY_MEDIUM",
                        silenceDurationMs: 500
                    }
                },
                // Optional: Configure voice
                speechConfig: {
                    voiceConfig: {
                        prebuiltVoiceConfig: {
                            voiceName: "Aoede" // You can change to: Puck, Charon, Kore, Fenrir, Aoede, Leda, Orus, Zephyr
                        }
                    }
                }
            };

            console.log('Connecting to Gemini Live API...');
            
            // Connect to Live API using the new SDK
            this.session = await this.genAI.live.connect(model, config);
            
            console.log('✅ Connected! Voice chat started.');
            console.log('🎤 Speak into your microphone');
            console.log('🎧 Using headphones is recommended to prevent feedback');
            console.log('Press Ctrl+C to quit\n');
            
            // Start all components
            await Promise.all([
                this.startListening(),
                this.startReceiving(),
                this.startPlaying()
            ]);
            
        } catch (error) {
            console.error('Session error:', error);
            this.cleanup();
        }
    }

    async startListening() {
        return new Promise((resolve, reject) => {
            try {
                console.log('🔴 Starting microphone...');
                
                // Create microphone instance
                this.micInstance = mic({
                    rate: SEND_SAMPLE_RATE,
                    channels: CHANNELS,
                    debug: false,
                    exitOnSilence: 0,
                    fileType: 'raw',
                    encoding: 'signed-integer'
                });

                // Get the input stream
                this.micInputStream = this.micInstance.getAudioStream();

                this.micInputStream.on('data', async (chunk) => {
                    if (!this.isSpeaking && this.session) {
                        try {
                            // Send real-time audio directly to the Live API
                            await this.session.sendRealtimeInput({
                                audio: {
                                    data: chunk,
                                    mimeType: "audio/pcm;rate=16000"
                                }
                            });
                        } catch (error) {
                            console.error('Error sending audio:', error);
                        }
                    }
                });

                this.micInputStream.on('startComplete', () => {
                    console.log('✅ Microphone recording started');
                    this.isRecording = true;
                });

                this.micInputStream.on('error', (error) => {
                    console.error('❌ Microphone stream error:', error);
                    reject(error);
                });

                this.micInputStream.on('end', () => {
                    console.log('🔴 Microphone stream ended');
                    resolve();
                });

                // Start recording
                this.micInstance.start();

            } catch (error) {
                console.error('Error starting microphone:', error);
                reject(error);
            }
        });
    }

    async startReceiving() {
        try {
            console.log('👂 Starting to listen for Gemini responses...');
            
            // Listen for responses from the Live API
            for await (const response of this.session.receive()) {
                console.log('📨 Received response from Gemini');
                
                // Handle audio data
                if (response.data) {
                    console.log(`🔊 Received audio data: ${response.data.length} bytes`);
                    this.audioInQueue.push(response.data);
                }
                
                // Handle text transcription (if available)
                if (response.serverContent?.outputTranscription?.text) {
                    console.log('💬 Gemini:', response.serverContent.outputTranscription.text);
                }
                
                // Handle session events
                if (response.serverContent?.turnComplete) {
                    console.log('✅ Turn complete');
                }
                
                if (response.serverContent?.interrupted) {
                    console.log('⚠️  Response interrupted');
                }
            }
        } catch (error) {
            console.error('Error receiving from Gemini:', error);
        }
    }

    async startPlaying() {
        return new Promise((resolve) => {
            // Process audio queue for playback
            const playInterval = setInterval(() => {
                if (this.audioInQueue.length > 0 && !this.isSpeaking) {
                    const audioData = this.audioInQueue.shift();
                    this.playAudio(audioData);
                }
            }, 50);

            // Keep the function running
            setTimeout(() => {
                clearInterval(playInterval);
                resolve();
            }, 1000 * 60 * 60); // Run for 1 hour max
        });
    }

    playAudio(audioData) {
        if (!this.speaker || this.isSpeaking) return;

        try {
            console.log(`🔊 Playing audio: ${audioData.length} bytes`);
            this.isSpeaking = true;
            
            // Temporarily pause recording to prevent feedback
            if (this.micInstance) {
                this.micInstance.pause();
            }

            this.speaker.write(audioData);
            
            // Calculate duration and resume recording after playback
            const durationMs = (audioData.length / (RECEIVE_SAMPLE_RATE * 2)) * 1000;
            
            setTimeout(() => {
                this.isSpeaking = false;
                if (this.micInstance && this.isRecording) {
                    this.micInstance.resume();
                }
                console.log('🎤 Microphone resumed');
            }, durationMs + 500); // Add 500ms buffer
            
        } catch (error) {
            console.error('Error playing audio:', error);
            this.isSpeaking = false;
        }
    }

    cleanup() {
        console.log('\n🧹 Cleaning up...');
        
        if (this.micInstance) {
            this.micInstance.stop();
        }
        
        if (this.speaker) {
            this.speaker.end();
        }
        
        if (this.silenceTimer) {
            clearTimeout(this.silenceTimer);
        }
        
        if (this.session) {
            try {
                this.session.close();
            } catch (error) {
                console.error('Error closing session:', error);
            }
        }
        
        console.log('👋 Voice chat session ended.');
        process.exit(0);
    }
}

// Handle graceful shutdown
process.on('SIGINT', () => {
    console.log('\n⚠️  Chat terminated by user.');
    if (global.audioLoop) {
        global.audioLoop.cleanup();
    } else {
        process.exit(0);
    }
});

process.on('uncaughtException', (error) => {
    console.error('Uncaught exception:', error);
    if (global.audioLoop) {
        global.audioLoop.cleanup();
    }
});

process.on('unhandledRejection', (reason, promise) => {
    console.error('Unhandled rejection at:', promise, 'reason:', reason);
    if (global.audioLoop) {
        global.audioLoop.cleanup();
    }
});

// Main execution
async function main() {
    try {
        global.audioLoop = new AudioLoop();
        await global.audioLoop.initialize();
    } catch (error) {
        console.error('❌ Failed to start voice chat:', error);
        process.exit(1);
    }
}

// Start the application
main().catch(console.error);