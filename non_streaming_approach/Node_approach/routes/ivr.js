const express = require('express');
const router = express.Router();
const VoiceResponse = require('twilio').twiml.VoiceResponse;
const axios = require('axios');
const logger = require('../logger');
require('dotenv').config();
const prompt = require('prompt-sync')({ sigint: true });

let mistralKey = process.env.MISTRAL_API_KEY;

if (!mistralKey) {
  mistralKey = prompt("Enter your Mistral API Key: ").trim();
  process.env.MISTRAL_API_KEY = mistralKey;
}

if (!process.env.MISTRAL_API_KEY) {
  console.error("Error: Mistral API Key is required to run this program.");
  process.exit(1);
}

const conversationHistory = {};

router.post('/call', (req, res) => {
  const twiml = new VoiceResponse();

  const gather = twiml.gather({
    input: 'speech',
    speechTimeout: 'auto',
    speechModel: 'deepgram_nova-2',
    enhanced: true,
    action: '/process_speech'
  });
  gather.say({ voice: 'Polly.Stephen-Neural' }, 'Welcome to the automated assistant. What can I help you with today?');

  twiml.hangup();

  res.type('text/xml');
  res.send(twiml.toString());
});

router.post('/process_speech', async (req, res) => {
  const voiceInput = (req.body.SpeechResult || '').trim();
  const callSid = req.body.CallSid || '';
  const twiml = new VoiceResponse();

  if (!voiceInput) {
    twiml.say({ voice: 'Polly.Stephen-Neural' }, "I couldn't understand that. Could you please repeat?");
    twiml.redirect('/call');
    return res.type('text/xml').send(twiml.toString());
  }

  console.log(`🎤 User said: ${voiceInput}`);

  logger.info(`🎤 User said: ${voiceInput}`);

  if (!conversationHistory[callSid]) conversationHistory[callSid] = [];
  conversationHistory[callSid].push({ role: 'user', content: voiceInput });

  try {
    const aiResponse = await queryLLM(conversationHistory[callSid]);

    // For this project to work with the local LLM/MIE_LLM_function_calling example you can uncomment the below line and comment the previous aiResponse declaration
    // const aiResponse = await queryLLM(voiceInput, callSid) 

    console.log(`AI Response: ${aiResponse}`);
    logger.info(`🤖 AI: ${aiResponse}`);
    conversationHistory[callSid].push({ role: 'assistant', content: aiResponse });
  } catch (err) {
    logger.error('Error calling LLM API:', err.message);
    conversationHistory[callSid].push({ role: 'assistant', content: "I'm sorry, I couldn't process your request." });
  }

  twiml.redirect('/speak_response');
  res.type('text/xml').send(twiml.toString());
});

router.post('/speak_response', (req, res) => {
  const callSid = req.body.CallSid || '';
  const twiml = new VoiceResponse();

  const lastResponse = conversationHistory[callSid]?.at(-1)?.content || "I'm sorry, I couldn't process your request.";

  const gather = twiml.gather({
    input: 'speech',
    speechTimeout: 'auto',
    speechModel: 'deepgram_nova-2',
    enhanced: true,
    action: '/process_speech',
    bargeIn: true
  });

  gather.say({ voice: 'Polly.Stephen-Neural' }, lastResponse);

  res.type('text/xml');
  res.send(twiml.toString());
});

router.post('/call_status', (req, res) => {
  const callSid = req.body.CallSid;
  const callStatus = req.body.CallStatus;

//   if (callStatus === 'completed') {
//     delete conversationHistory[callSid];
//     const fs = require('fs');
//     fs.writeFileSync('logs/conversation.log', '');  // truncate log
//     logger.info(`Call ${callSid} ended — conversation log cleared.`);
//   }

  res.sendStatus(204);
});

async function queryLLM(history) {
  try{  
    const MISTRAL_API_KEY = process.env.MISTRAL_API_KEY;

    const systemPrompt = `You are an intelligent IVR assistant for a hospital. Your goal is to assist callers by providing accurate information about the hospital, including operational hours, address, and general guidance. 

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

                            Ensure that all responses are **formatted clearly**, so the caller can easily understand the details.`; 

        const messages = [{ role: 'system', content: systemPrompt }, ...history];

        const response = await axios.post(
            'https://api.mistral.ai/v1/chat/completions',
            {
            model: 'mistral-small',
            messages
            },
            {
            headers: {
                'Authorization': `Bearer ${MISTRAL_API_KEY}`,
                'Content-Type': 'application/json'
            }
            }
        );

        if(response.status == 200){
            return response.data["choices"][0]["message"]["content"];
        }
        else{
            return `Error: ${response.data}`;
        }  
    }
    catch (error) {
        console.error('Error querying LLM:', error.message);
        return "I'm sorry, I couldn't process your request.";
    }         

}


// For this project to work with the local LLM/MIE_LLM_function_calling example you can uncomment the below line and comment the previous queryLLM declaration
// async function queryLLM(userInput, callSid) {
//     try {
//       const url = 'http://127.0.0.1:5000/chat';
//       const payload = {
//         call_sid: callSid,
//         user_input: userInput
//       };
  
//       const response = await axios.post(url, payload);
  
//       if (response.status == 200) {
//         return response.data.response;
//       } else {
//         throw new Error(`Request failed with status code ${response.status}: ${response.statusText}`);
//       }
//     } catch (err) {
//       console.error('Error calling local LLM API:', err);
//       return "I'm sorry, I couldn't process your request.";
//     }
//   }

module.exports = router;
