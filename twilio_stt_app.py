from flask import Flask, request, Response
from twilio.twiml.voice_response import VoiceResponse, Gather
import requests
import threading
import os


MISTRAL_API_KEY = os.getenv("MISTRAL_API_KEY")

if not MISTRAL_API_KEY:
    MISTRAL_API_KEY = input("Enter your Mistral API Key: ").strip()
    os.environ["MISTRAL_API_KEY"] = MISTRAL_API_KEY  

# Ensure API key is not empty
if not MISTRAL_API_KEY:
    print("Error: Mistral API Key is required to run this program.")
    exit(1)

app = Flask(__name__)

# Store conversation history per call
conversation_history = {}


@app.route("/call", methods=["POST"])
def call():

    response = VoiceResponse()
    
    response.say("Welcome to the automated assistant. What can I help you with today?", voice='Polly.Joanna')

    gather = Gather(
        input="speech",
        speech_timeout="auto",
        speech_model="experimental_conversations",
        enhanced=True,
        action="/process_speech"
    )

    response.append(gather)

    return Response(str(response), mimetype="text/xml")



# Process Speech Input, Call AI, and Redirect to `/speak_response`
@app.route("/process_speech", methods=["POST"])
def process_speech():
    voice_input = request.form.get("SpeechResult", "").strip()
    call_sid = request.form.get("CallSid", "")

    response = VoiceResponse()

    if not voice_input:
        response.say("I couldn't understand that. Could you please repeat?", voice='Polly.Joanna')
        response.redirect("/call") 
        return Response(str(response), mimetype="text/xml")

    print(f"🎤 User said: {voice_input}")

    # Initialize conversation history if it's a new call
    if call_sid not in conversation_history:
        conversation_history[call_sid] = []

    # Add user input to history
    conversation_history[call_sid].append({"role": "user", "content": voice_input})

    # Run LLM Query in a Separate Thread
    def process_ai():
        ai_response = query_llm(conversation_history[call_sid])  
        print(f"AI Response: {ai_response}")

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

    response.say(ai_response, voice='Polly.Joanna')

    response.say("May I help you with something else? If not, you may hang up the phone.", voice='Polly.Joanna')

    # Gather More Speech Input (Loop the conversation)
    gather = Gather(
        input="speech",
        speech_timeout="auto",
        speech_model="experimental_conversations",
        enhanced=True,
        action="/process_speech"  
    )

    response.append(gather)

    return Response(str(response), mimetype="text/xml")



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
        return "I'm sorry, I couldn't process your request."

# Run Flask
if __name__ == "__main__":
    app.run(port=5000, debug=True)
