from flask import Flask, request, Response
from twilio.twiml.voice_response import VoiceResponse, Gather
import requests
import threading
import os
import logging
from logging.handlers import RotatingFileHandler


MISTRAL_API_KEY = os.getenv("MISTRAL_API_KEY")

if not MISTRAL_API_KEY:
    MISTRAL_API_KEY = input("Enter your Mistral API Key: ").strip()
    os.environ["MISTRAL_API_KEY"] = MISTRAL_API_KEY  

# Ensure API key is not empty
if not MISTRAL_API_KEY:
    print("Error: Mistral API Key is required to run this program.")
    exit(1)

app = Flask(__name__)

# --- Set up Logging (Moved OUTSIDE __main__) ---
if not os.path.exists('logs'):
    os.makedirs('logs')

log_formatter = logging.Formatter(
    "[%(levelname)s] %(asctime)s - %(name)s - %(message)s",
    datefmt='%Y-%m-%d %H:%M:%S'
)

file_handler = RotatingFileHandler(
    'logs/conversation.log', maxBytes=10*1024*1024, backupCount=5, delay=False
)

# file_handler.flush = lambda: None 
file_handler.setFormatter(log_formatter)
file_handler.setLevel(logging.DEBUG)

console_handler = logging.StreamHandler()
console_handler.setFormatter(log_formatter)
console_handler.setLevel(logging.DEBUG)

app.logger.addHandler(file_handler)
app.logger.addHandler(console_handler)

app.logger.setLevel(logging.DEBUG)




# Store conversation history per call
conversation_history = {}


@app.route("/call", methods=["POST"])
def call():

    response = VoiceResponse()
    
    response.say("Welcome to the automated assistant. What can I help you with today?", voice='Polly.Stephen-Neural')

    gather = Gather(
        input="speech",
        speech_timeout="auto",
        speech_model="deepgram_nova-2",
        enhanced=True,
        action="/process_speech"
    )

    response.append(gather)

    # When the call ends, Twilio will POST to this URL
    response.hangup()

    return Response(str(response), mimetype="text/xml")



# Process Speech Input, Call AI, and Redirect to `/speak_response`
@app.route("/process_speech", methods=["POST"])
def process_speech():
    voice_input = request.form.get("SpeechResult", "").strip()
    call_sid = request.form.get("CallSid", "")

    response = VoiceResponse()

    if not voice_input:
        response.say("I couldn't understand that. Could you please repeat?", voice='Polly.Stephen-Neural')
        response.redirect("/call") 
        return Response(str(response), mimetype="text/xml")

    print(f"🎤 User said: {voice_input}")
    app.logger.info(f"🎤 User said: {voice_input}")
    for handler in app.logger.handlers:
        if hasattr(handler, 'flush'):
            handler.flush()

    # Initialize conversation history if it's a new call
    if call_sid not in conversation_history:
        conversation_history[call_sid] = []

    # Add user input to history
    conversation_history[call_sid].append({"role": "user", "content": voice_input})

    # Run LLM Query in a Separate Thread
    def process_ai():
        ai_response = query_llm(conversation_history[call_sid])  

        # For this project to work with the local LLM/MIE_LLM_function_calling example you can uncomment the below line and comment the previous ai_response declaration
        # ai_response = query_llm(voice_input, call_sid) 

        print(f"AI Response: {ai_response}")
        app.logger.info(f"🤖 AI Response: {ai_response}")
        for handler in app.logger.handlers:
            if hasattr(handler, 'flush'):
                handler.flush()

        # Add AI response to history
        conversation_history[call_sid].append({"role": "assistant", "content": ai_response})

    thread = threading.Thread(target=process_ai)
    thread.start()
    thread.join()  # Ensure AI processing completes before moving forward

    response.redirect("/speak_response")

    return Response(str(response), mimetype="text/xml")


# Speak AI Response & Ask User for More Questions
@app.route("/speak_response", methods=["POST"])
def speak_response():
    call_sid = request.form.get("CallSid", "")

    response = VoiceResponse()

    ai_response = (
        conversation_history[call_sid][-1]["content"]
        if call_sid in conversation_history and conversation_history[call_sid]
        else "I'm sorry, I couldn't process your request."
    )

    # Gather input while speaking, allowing barge-in
    gather = Gather(
        input="speech",
        speech_timeout="auto",
        speech_model="deepgram_nova-2",
        enhanced=True,
        action="/process_speech",
        bargeIn=True  
    )

    # Move the AI response inside Gather to allow interruption
    gather.say(ai_response, voice='Polly.Stephen-Neural')

    response.append(gather)

    return Response(str(response), mimetype="text/xml")


@app.route("/call_status", methods=["POST"])
def call_status():
    call_sid = request.form.get("CallSid", "")
    call_status = request.form.get("CallStatus", "")

    if call_status == "completed":
        if call_sid in conversation_history:
            del conversation_history[call_sid]

        with open("logs/conversation.log", "w") as f:
            f.write("")  # truncate the file

        app.logger.info(f"Call {call_sid} ended — conversation log cleared.")

    return ("", 204)




# Function to Interact with LLM with History
def query_llm(conversation_history):
    try:
        system_prompt = """You are an intelligent IVR assistant for a hospital. Your goal is to assist callers by providing accurate information about the hospital, including operational hours, address, and general guidance. 

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
        """

        # Format conversation history for LLM and give it the system prompt
        formatted_history = [{"role": "system", "content": system_prompt}] + conversation_history

        # Mistral API approach 
        headers = {
            "Authorization": f"Bearer {MISTRAL_API_KEY}",
            "Content-Type": "application/json"
        }

        payload = {
            "model": "mistral-small",  
            "messages": formatted_history
        }

        response = requests.post("https://api.mistral.ai/v1/chat/completions", json=payload, headers=headers)
        
        if response.status_code == 200:
            return response.json()["choices"][0]["message"]["content"]
        else:
            return f"Error: {response.json()}"

    except Exception as e:
        print("Error calling LLM API:", str(e))  # Debugging output
        app.logger.error("Error calling LLM API:", str(e)) 
        for handler in app.logger.handlers:
            if hasattr(handler, 'flush'):
                handler.flush()
        return "I'm sorry, I couldn't process your request."
    

# For this project to work with the local LLM/MIE_LLM_function_calling example you can uncomment the below line and comment the previous query_llm declaration
# def query_llm(user_input, call_sid):

#     url = "http://127.0.0.1:5000/chat"
#     payload = {
#         "call_sid": call_sid,
#         "user_input": user_input
#     }

#     response = requests.post(url, json=payload)

#     if response.status_code == 200:
#         result = response.json()
#         return result['response']
#     else:
#         raise Exception(f"Request failed with status code {response.status_code}: {response.text}")


# Run Flask
if __name__ == "__main__":
    # For this project to work with the local LLM/MIE_LLM_function_calling example maybe change the port
    app.run(port=5000, debug=True)
