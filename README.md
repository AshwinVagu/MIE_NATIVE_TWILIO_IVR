# 📞 MIE - IVR Assistant with Native Twilio TTS and STT

This project is an **Interactive Voice Response (IVR) system** built using **Flask**, **Twilio Voice API**, and **Mistral AI**.  
It allows users to call a phone number, ask questions, and receive AI-generated responses in a **conversational voice interface**.

---

## ** Features**
✅ **Speech-to-Text (STT) with Twilio** – Converts spoken input into text.  
✅ **Text-to-Speech (TTS) with Twilio Polly** – Converts AI-generated responses into speech.  
✅ **Conversational AI with Mistral** – Maintains history for back-and-forth dialogue.  
✅ **Flask Web Server** – Handles incoming Twilio calls and processes speech.  
✅ **Secure API Key Handling** – Prompts for `MISTRAL_API_KEY` only once.  
✅ **Scalable & Modular** – Designed for real-world IVR automation.  

---

## IVR Call Flow - Sequence Diagram

```mermaid
sequenceDiagram
    participant Caller
    participant Twilio
    participant Flask Server
    participant Mistral AI

    Caller->>+Twilio: Calls IVR phone number
    Twilio->>+Flask Server: "A Call Comes In" → /call (Webhook)
    Flask Server->>+Twilio: Plays welcome message & starts speech recognition
    Twilio->>+Caller: "Welcome to the automated assistant. What can I help you with today?"

    Caller->>+Twilio: Asks a question (Speech)
    Twilio->>+Flask Server: Transcribes speech → /process_speech
    Flask Server->>+Mistral AI: Sends transcribed text & conversation history
    Mistral AI-->>Flask Server: Returns AI-generated response

    Flask Server->>+Twilio: Redirects response → /speak_response
    Twilio->>+Caller: Reads AI response (TTS)
    
    Caller->>+Twilio: Can ask another question (Loop)
    Twilio->>+Flask Server: Transcribes new question → /process_speech
    Flask Server->>+Mistral AI: Sends updated conversation history
    Mistral AI-->>Flask Server: Returns new AI-generated response

    Flask Server->>+Twilio: Redirects new response → /speak_response
    Twilio->>+Caller: "May I help you with something else?"
    
    Caller->>+Twilio: Hangs up (Optional)
    Twilio-->>Flask Server: Call Ends


## ** How It Works**
### **1️. Call Flow**
1. A user calls the IVR phone number (configured in Twilio).  
2. Twilio plays a **welcome message** and asks, **"What can I help you with today?"**  
3. **Twilio Speech-to-Text (STT)** transcribes the user's speech.  
4. The transcribed text is sent to **Mistral AI** via an API call.  
5. **Mistral AI** generates a response based on conversation history.  
6. Twilio's **Text-to-Speech (TTS)** reads out the AI's response.  
7. The user can continue the conversation or hang up.

### **2️. API Flow**
| **Endpoint** | **Purpose** |
|-------------|------------|
| **`/call`** | Starts the IVR and prompts for user input (speech). |
| **`/process_speech`** | Receives and processes transcribed speech, calls AI. |
| **`/speak_response`** | Reads the AI response and asks if the user has more questions. |

---

## ** Setup Instructions**
### **1️. Prerequisites**
- Python 3.7+ installed
- Twilio account ([Sign up for free](https://www.twilio.com/try-twilio))
- Mistral AI API Key ([Get it here](https://mistral.ai))
- ngrok (to expose Flask to the internet)

### **2️. Install Dependencies**
Run the following command:

pip install -r requirements.txt

### **3️. Set Up Twilio Phone Number**
- Log in to Twilio Console.
- Buy a phone number (or use a free trial number).(You should get free credits the first time)
- Go to Voice & Messaging Settings.
- Set "A Call Comes In" webhook to:
- http://your-ngrok-url/call (Replace your-ngrok-url with your actual ngrok public URL)
- Use POST method.
- Click Save.

### **4️. Start the Flask Server**

python app.py

It will ask for the Mistral API Key once, then store it in memory.


### **5️. Expose Server with ngrok**
- In a separate terminal, run:

ngrok http http://127.0.0.1:5000

- This gives you a public URL like:

https://random.ngrok-free.app

Copy this ngrok URL and update it in Twilio's webhook settings.


## ** Configuration**

Environment Variable	      Description
MISTRAL_API_KEY	API     ->    key for Mistral AI.

You can also store the API key in a .env file:

MISTRAL_API_KEY=your-key-here

## ** Example API Response**

Caller Asks:
"What are the hospital's working hours?"
IVR Responds:
"The hospital operates from Monday to Friday, 8:00 AM to 6:00 PM.
We remain closed on Saturdays and Sundays.
May I help you with anything else?"