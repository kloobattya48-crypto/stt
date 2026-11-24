"""
خادم ويب خفيف وسريع لتحويل الصوت إلى نص باللغة العربية
(Arabic Speech-to-Text Lightweight Web App Server)
"""

import http.server
import socketserver
import json
import os
import sys
import webbrowser
import tempfile

try:
    import speech_recognition as sr
except ImportError:
    print("يرجى تثبيت مكتبة SpeechRecognition أولاً عبر الأمر:")
    print("python -m pip install SpeechRecognition")
    sys.exit(1)

from audio_pipeline import remove_noise, verify_voice

PORT = 8000
DIRECTORY = os.path.dirname(os.path.abspath(__file__))

class SpeechToTextHandler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=DIRECTORY, **kwargs)

    def do_POST(self):
        if self.path == '/api/transcribe':
            try:
                content_length = int(self.headers.get('Content-Length', 0))
                if content_length == 0:
                    self._send_json({"allowed": False, "error": "الملف الصوتي فارغ"}, status=400)
                    return

                # قراءة بيانات الملف الصوتي (WAV)
                audio_bytes = self.rfile.read(content_length)

                # 1. تقليل الضوضاء وفلترة ترددات الكلام البشري
                clean_bytes = remove_noise(audio_bytes)

                # 2. التحقق من هوية الصوت (Voice Verification)
                verification = verify_voice(clean_bytes)
                if not verification.get("allowed", False):
                    # إيقاف التحويل لنص وإرجاع استجابة تفيد بعدم التطابق أو عدم السماح
                    err_msg = verification.get("message", "الصوت غير مسموح به أو غير مطابق للشخص المصرح له")
                    self._send_json({
                        "status": "forbidden",
                        "allowed": False,
                        "error": err_msg,
                        "verification": verification
                    }, status=403)
                    return

                # 3. حفظ الصوت النظيف مؤقتاً للتحويل إلى نص (STT)
                with tempfile.NamedTemporaryFile(delete=False, suffix=".wav") as temp_audio:
                    temp_audio.write(clean_bytes)
                    temp_audio_path = temp_audio.name

                recognizer = sr.Recognizer()
                try:
                    with sr.AudioFile(temp_audio_path) as source:
                        audio_data = recognizer.record(source)
                        # التعرف على الكلام باللغة العربية عبر Google Web Speech API (مجاناً وبدون مساحة)
                        text = recognizer.recognize_google(audio_data, language="ar-AR")
                        self._send_json({
                            "status": "success",
                            "allowed": True,
                            "text": text,
                            "verification": verification
                        })
                except sr.UnknownValueError:
                    self._send_json({
                        "status": "no_speech",
                        "allowed": True,
                        "error": "لم يتمكن المحرك من فهم الصوت أو لا يوجد كلام واضح في التسجيل.",
                        "verification": verification
                    }, status=200)
                except sr.RequestError as e:
                    self._send_json({"error": f"تعذر الاتصال بخدمة التعرف على الصوت: {e}"}, status=503)
                except Exception as e:
                    self._send_json({"error": f"خطأ أثناء قراءة الصوت: {str(e)}"}, status=500)
                finally:
                    if os.path.exists(temp_audio_path):
                        try:
                            os.remove(temp_audio_path)
                        except Exception:
                            pass

            except Exception as e:
                self._send_json({"error": f"خطأ غير متوقع: {str(e)}"}, status=500)
        else:
            self.send_error(404, "Page Not Found")

    def _send_json(self, data, status=200):
        response_bytes = json.dumps(data, ensure_ascii=False).encode('utf-8')
        self.send_response(status)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Content-Length', str(len(response_bytes)))
        self.send_header('Access-Control-Allow-Origin', '*')
        self.end_headers()
        self.wfile.write(response_bytes)

    def end_headers(self):
        # منع التخزين المؤقت لتحديث التغييرات فورياً
        self.send_header('Cache-Control', 'no-cache, no-store, must-revalidate')
        super().end_headers()

def run_server():
    os.chdir(DIRECTORY)
    socketserver.TCPServer.allow_reuse_address = True
    
    with socketserver.TCPServer(("", PORT), SpeechToTextHandler) as httpd:
        url = f"http://localhost:{PORT}"
        print("=" * 60)
        print("🚀 تم تشغيل خادم المحوّل الصوتي العربي بنجاح!")
        print(f"🌐 افتحي الرابط في المتصفح: {url}")
        print("💡 مميزات التطبيق:")
        print("  - تسجيل مباشر بالميكروفون عبر Web Speech API")
        print("  - معالجة وفلترة الصوت وتقليل الضوضاء (Noise Reduction & Bandpass Filter)")
        print("  - التحقق من الصوت (Voice Verification)")
        print("  - رفع ملفات صوتية بدون أي نماذج ثقيلة")
        print("  - استهلاك مساحة شبه معدوم على الجهاز")
        print("=" * 60)
        print("اضغطي Ctrl + C لإيقاف الخادم في أي وقت.\n")
        
        webbrowser.open(url)
        
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            print("\nتم إيقاف الخادم.")
            httpd.server_close()

if __name__ == "__main__":
    run_server()
