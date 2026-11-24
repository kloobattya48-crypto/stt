import os
import requests

def test_transcribe_api():
    url = "http://localhost:8000/api/transcribe"
    audio_path = "test.wav.wav"

    if not os.path.exists(audio_path):
        print(f"خطأ: ملف الصوت غير موجود في المسار: {audio_path}")
        return

    headers = {
        "Content-Type": "audio/wav"
    }

    print(f"جاري قراءة الملف: {audio_path}...")
    with open(audio_path, "rb") as f:
        audio_data = f.read()

    print(f"جاري إرسال طلب POST إلى: {url}...")
    try:
        response = requests.post(url, data=audio_data, headers=headers)
        print("status_code:", response.status_code)
        try:
            print("response.json():", response.json())
        except Exception:
            print("response text (ليس JSON):", response.text)
    except requests.exceptions.ConnectionError:
        print("خطأ في الاتصال: تأكد من تشغيل الخادم أولاً عبر الأمر: python app.py")

if __name__ == "__main__":
    test_transcribe_api()
