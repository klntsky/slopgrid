use wasm_bindgen::{JsCast, JsValue, closure::Closure};
use web_sys::{AudioContext, OscillatorType};

// The game may also use AudioContext directly for buffers, filters, or mixing.
pub fn tone(
    context: &AudioContext,
    frequency_hz: f32,
    duration_seconds: f64,
    volume: f32,
) -> Result<(), JsValue> {
    if !frequency_hz.is_finite()
        || frequency_hz <= 0.0
        || !duration_seconds.is_finite()
        || duration_seconds <= 0.0
        || !volume.is_finite()
        || !(0.0..=1.0).contains(&volume)
    {
        return Err(JsValue::from_str("Invalid tone parameters"));
    }
    let oscillator = context.create_oscillator()?;
    let gain = context.create_gain()?;
    oscillator.set_type(OscillatorType::Sine);
    oscillator.frequency().set_value(frequency_hz);
    gain.gain().set_value(volume);
    oscillator.connect_with_audio_node(&gain)?;
    gain.connect_with_audio_node(&context.destination())?;

    let ended_oscillator = oscillator.clone();
    let ended_gain = gain.clone();
    let ended = Closure::once_into_js(move || {
        let _ = ended_oscillator.disconnect();
        let _ = ended_gain.disconnect();
        ended_oscillator.set_onended(None);
    });
    oscillator.set_onended(Some(ended.unchecked_ref()));
    let now = context.current_time();
    oscillator.start_with_when(now)?;
    oscillator.stop_with_when(now + duration_seconds)?;
    Ok(())
}
