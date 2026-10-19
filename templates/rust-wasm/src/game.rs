use crate::{Frame, Input};
use wasm_bindgen::JsValue;
use web_sys::{AudioContext, WebGl2RenderingContext as Gl};

// Game-specific state belongs here. The runtime imposes no simulation model.
pub struct Game {
    pub clear_color: [f32; 4],
}

impl Game {
    pub fn new(_gl: &Gl, _input: &mut Input) -> Result<Self, JsValue> {
        Ok(Self {
            clear_color: [0.0, 0.0, 0.0, 1.0],
        })
    }

    pub fn frame(
        &mut self,
        gl: &Gl,
        _input: &Input,
        _frame: Frame,
        _audio: Option<&AudioContext>,
    ) -> Result<(), JsValue> {
        let [red, green, blue, alpha] = self.clear_color;
        gl.clear_color(red, green, blue, alpha);
        gl.clear(Gl::COLOR_BUFFER_BIT);
        Ok(())
    }
}

// AudioContext is available after the first keyboard/pointer gesture.
// Use audio::tone(context, frequency_hz, duration_seconds, volume), or the raw
// Web Audio API for sample playback, mixing, and synthesis.
