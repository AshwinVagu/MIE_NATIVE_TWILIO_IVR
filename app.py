from flask import Flask, request, Response
from twilio.twiml.voice_response import VoiceResponse
import requests
import openai  
import os
import time
from twilio.rest import Client

app = Flask(__name__)

# OPENAI approach:
# Replace with OpenAI API key or use an open-source alternative
# openai.api_key = "openai-api-key"

# Mistril API approach:
MISTRAL_API_KEY = "mistral-api-key"

# Twilio Credentials
TWILIO_ACCOUNT_SID = "twilio-account-sid"
TWILIO_AUTH_TOKEN = "twilio-auth-token"

client = Client(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN)









# ----> APPROACH ONE WHERE /IVR IS CALLED FIRST

# Process incoming calls
# @app.route("/ivr", methods=["POST"])
# def ivr():
#     response = VoiceResponse()
    
#     # Ask for user input via voice
#     response.say("Welcome to the automated assistant. Please ask your question after the beep.", voice='Polly.Joanna')

#     # Record the caller's response
#     response.record(timeout=2, transcribe=True, transcribe_callback="/transcription", max_length=10, play_beep=True, finish_on_key="#",  wait_for_beep=True)

#     return Response(str(response), mimetype="text/xml")

# # Process transcription results
# @app.route("/transcription", methods=["POST"])
# def transcription():
#     print("Transcription received")
#     transcription_text = request.form.get("TranscriptionText", "")

#     if transcription_text:
#         print(f"User said: {transcription_text}")

#         # Query LLM for response
#         ai_response = query_llm(transcription_text)

#         print("AI response: ", ai_response)

#         # Return Twilio response
#         response = VoiceResponse()
#         response.say(ai_response, voice='Polly.Joanna')

#         return Response(str(response), mimetype="text/xml")

#     return "No transcription received", 400










# ----> APPROACH TWO WHERE /TRANSCRIPTION IS CALLED FIRST DIRECTLY
@app.route("/transcription", methods=["POST"])
def transcription():
    recording_url = request.form.get("RecordingUrl", "")
    recording_sid = request.form.get("RecordingSid", "")

    print(f"Recording SID: {recording_sid}")
    print(f"Recording URL: {recording_url}")

    if not recording_sid:
        return "No recording SID received", 400

    # Poll for transcription (max wait: 10 sec)
    for _ in range(10):
        time.sleep(1)  # Wait 1 sec before checking
        recording = client.recordings(recording_sid).fetch()
        
        if recording.transcription_text:  # If transcription is ready
            transcription_text = recording.transcription_text
            print(f"User said: {transcription_text}")

            # Query OpenAI LLM
            ai_response = query_llm(transcription_text)
            print("AI response: ", ai_response)

            # Respond using Twilio
            response = VoiceResponse()
            response.say(ai_response, voice='Polly.Joanna')

            return Response(str(response), mimetype="text/xml")

    return "Transcription not ready", 400

# Function to interact with LLM
def query_llm(prompt):
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

        # OPENAI approach:
        # # New OpenAI API Call Syntax
        # client = openai.OpenAI(api_key=openai.api_key)  # Create a client instance

        # response = client.chat.completions.create(
        #     model="gpt-3.5-turbo",
        #     messages=[
        #         {"role": "system", "content": system_prompt},
        #         {"role": "user", "content": prompt}
        #     ]
        # )

        # return response.choices[0].message.content



        # MISTRAL API approach:
        headers = {
            "Authorization": f"Bearer {MISTRAL_API_KEY}",
            "Content-Type": "application/json"
        }

        payload = {
            "model": "mistral-small",  
            "messages": [
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": prompt}
            ]
        }

        response = requests.post("https://api.mistral.ai/v1/chat/completions", json=payload, headers=headers)
        
        if response.status_code == 200:
            return response.json()["choices"][0]["message"]["content"]
        else:
            return f"Error: {response.json()}"

    except Exception as e:
        print("Error calling OpenAI API:", str(e))  # Debugging output
        return "I'm sorry, I couldn't process your request."

# Run Flask
if __name__ == "__main__":
    app.run(port=5000, debug=True)
