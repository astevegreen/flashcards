package app.flashcards.localfirst;

import android.speech.tts.TextToSpeech;
import android.speech.tts.Voice;
import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.util.Locale;
import java.util.Set;
import java.util.UUID;

/**
 * Lightweight native Android TextToSpeech bridge for {@code DeviceSpeechPlayer} (§7.1).
 * Android System WebView omits {@code window.speechSynthesis}, so offline/device TTS on Android
 * goes through {@link TextToSpeech} directly.
 */
@CapacitorPlugin(name = "AndroidTts")
public class AndroidTtsPlugin extends Plugin implements TextToSpeech.OnInitListener {

    private TextToSpeech tts;
    private volatile boolean ready = false;
    private volatile boolean initFailed = false;

    @Override
    public void load() {
        try {
            tts = new TextToSpeech(getContext(), this);
        } catch (Exception e) {
            initFailed = true;
            ready = false;
        }
    }

    @Override
    public void onInit(int status) {
        if (status == TextToSpeech.SUCCESS) {
            ready = true;
            initFailed = false;
        } else {
            ready = false;
            initFailed = true;
        }
        JSObject payload = new JSObject();
        payload.put("available", ready);
        notifyListeners("voicesChanged", payload, true);
    }

    @PluginMethod
    public void isAvailable(PluginCall call) {
        JSObject ret = new JSObject();
        ret.put("available", ready && !initFailed && tts != null);
        call.resolve(ret);
    }

    @PluginMethod
    public void getVoices(PluginCall call) {
        JSObject ret = new JSObject();
        JSArray list = new JSArray();
        if (ready && tts != null) {
            try {
                Voice defaultVoice = tts.getDefaultVoice();
                Set<Voice> voices = tts.getVoices();
                if (voices != null) {
                    for (Voice v : voices) {
                        if (v == null || v.getLocale() == null) continue;
                        JSObject obj = new JSObject();
                        obj.put("name", v.getName());
                        obj.put("lang", v.getLocale().toLanguageTag());
                        obj.put("localService", !v.isNetworkConnectionRequired());
                        if (defaultVoice != null && v.equals(defaultVoice)) {
                            obj.put("default", true);
                        }
                        list.put(obj);
                    }
                }
            } catch (Exception ignored) {
                // Some OEM engines throw on getVoices() before voice data is downloaded.
            }
        }
        ret.put("voices", list);
        call.resolve(ret);
    }

    @PluginMethod
    public void speak(PluginCall call) {
        if (!ready || tts == null) {
            call.reject("Android TextToSpeech engine is not ready.");
            return;
        }
        String text = call.getString("text", "");
        String lang = call.getString("lang", "en-US");
        String voiceName = call.getString("voiceName");
        double rate = call.getDouble("rate", 1.0);
        if (text == null || text.trim().isEmpty()) {
            call.reject("No speakable text provided.");
            return;
        }
        // The engine refuses text longer than this (N8); speak the start instead of failing.
        int maxLength = TextToSpeech.getMaxSpeechInputLength();
        if (text.length() > maxLength) {
            int end = maxLength;
            if (Character.isHighSurrogate(text.charAt(end - 1))) end -= 1;
            text = text.substring(0, end);
        }

        try {
            tts.stop();
            boolean voiceApplied = false;
            if (voiceName != null && !voiceName.isEmpty()) {
                Set<Voice> voices = tts.getVoices();
                if (voices != null) {
                    for (Voice v : voices) {
                        if (v != null && voiceName.equals(v.getName())) {
                            tts.setVoice(v);
                            voiceApplied = true;
                            break;
                        }
                    }
                }
            }
            if (!voiceApplied) {
                Locale locale = Locale.forLanguageTag(lang != null ? lang : "en-US");
                int langResult = tts.setLanguage(locale);
                if (langResult == TextToSpeech.LANG_MISSING_DATA || langResult == TextToSpeech.LANG_NOT_SUPPORTED) {
                    call.reject("Language not supported by Android TextToSpeech: " + lang);
                    return;
                }
            }
            float clampedRate = (float) Math.max(0.5, Math.min(2.0, rate));
            tts.setSpeechRate(clampedRate);
            String utteranceId = "flash-" + UUID.randomUUID();
            int res = tts.speak(text, TextToSpeech.QUEUE_FLUSH, null, utteranceId);
            if (res == TextToSpeech.ERROR) {
                call.reject("Android TextToSpeech failed to queue speech.");
                return;
            }
            call.resolve();
        } catch (Exception e) {
            call.reject("Android TextToSpeech error: " + e.getMessage());
        }
    }

    @PluginMethod
    public void stop(PluginCall call) {
        if (tts != null) {
            try {
                tts.stop();
            } catch (Exception ignored) {
                // Ignore stop errors during teardown.
            }
        }
        call.resolve();
    }

    @Override
    protected void handleOnDestroy() {
        ready = false;
        if (tts != null) {
            try {
                tts.stop();
                tts.shutdown();
            } catch (Exception ignored) {
                // Ignore shutdown errors.
            }
            tts = null;
        }
        super.handleOnDestroy();
    }
}
