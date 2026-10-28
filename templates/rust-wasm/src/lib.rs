pub mod audio;
mod game;

use game::Game;
use std::collections::HashSet;
use wasm_bindgen::{JsCast, prelude::*};
use web_sys::{
    AudioContext, HtmlCanvasElement, KeyboardEvent, PointerEvent, WebGl2RenderingContext,
};

#[derive(Default)]
pub struct Input {
    pub focused: bool,
    pub keys_down: HashSet<String>,
    pub key_events: Vec<KeyboardEvent>,
    pub pointer_events: Vec<PointerEvent>,
    // Primary pointer coordinates and wheel deltas are in CSS pixels.
    pub pointer: [f64; 2],
    pub buttons: u16,
    pub wheel: [f64; 2],
    // The game opts into preventing browser defaults, independently of delivery.
    pub capture_keys: HashSet<String>,
    pub capture_pointer: bool,
    pub capture_wheel: bool,
}

impl Input {
    fn end_frame(&mut self) {
        self.key_events.clear();
        self.pointer_events.clear();
        self.wheel = [0.0; 2];
    }

    fn release(&mut self) {
        self.keys_down.clear();
        self.buttons = 0;
        self.end_frame();
    }
}

#[derive(Clone, Copy)]
pub struct Frame {
    pub now: f64,
    pub delta: f64,
    pub width: u32,
    pub height: u32,
    pub scale: f64,
}

#[wasm_bindgen]
pub struct App {
    gl: WebGl2RenderingContext,
    game: Game,
    input: Input,
    audio: Option<AudioContext>,
    frame: Frame,
    previous: Option<f64>,
}

#[wasm_bindgen]
impl App {
    #[wasm_bindgen(constructor)]
    pub fn new(canvas: &HtmlCanvasElement) -> Result<App, JsValue> {
        let gl = canvas
            .get_context("webgl2")?
            .ok_or_else(|| JsValue::from_str("WebGL2 is unavailable"))?
            .dyn_into::<WebGl2RenderingContext>()?;
        let mut input = Input::default();
        let game = Game::new(&gl, &mut input)?;
        Ok(Self {
            gl,
            game,
            input,
            audio: None,
            frame: Frame {
                now: 0.0,
                delta: 0.0,
                width: 0,
                height: 0,
                scale: 1.0,
            },
            previous: None,
        })
    }

    pub fn resize(&mut self, width: u32, height: u32, scale: f64) {
        self.frame.width = width;
        self.frame.height = height;
        self.frame.scale = scale;
        self.gl.viewport(0, 0, width as i32, height as i32);
    }

    // Timestamp and delta are seconds. No fixed timestep or delta clamp is imposed.
    pub fn frame(&mut self, now: f64) -> Result<(), JsValue> {
        self.frame.now = now;
        self.frame.delta = self.previous.map_or(0.0, |previous| now - previous);
        self.previous = Some(now);
        self.game
            .frame(&self.gl, &self.input, self.frame, self.audio.as_ref())?;
        self.input.end_frame();
        Ok(())
    }

    pub fn key(&mut self, event: KeyboardEvent, down: bool) -> bool {
        let code = event.code();
        let capture = self.input.capture_keys.contains(&code)
            && !event.ctrl_key()
            && !event.meta_key()
            && !event.alt_key();
        if down {
            if !self.input.keys_down.contains(&code) {
                self.input.keys_down.insert(code);
            }
        } else {
            self.input.keys_down.remove(&code);
        }
        self.input.key_events.push(event);
        capture
    }

    pub fn pointer(&mut self, event: PointerEvent, x: f64, y: f64) -> bool {
        if event.is_primary() {
            self.input.pointer = [x, y];
            self.input.buttons = event.buttons();
            if event.type_() == "pointercancel" {
                self.input.buttons = 0;
            }
        }
        self.input.pointer_events.push(event);
        self.input.capture_pointer
    }

    pub fn wheel(&mut self, x: f64, y: f64) -> bool {
        self.input.wheel[0] += x;
        self.input.wheel[1] += y;
        self.input.capture_wheel
    }

    pub fn focus(&mut self, focused: bool) {
        self.input.focused = focused;
        if !focused {
            self.reset();
        }
    }

    pub fn reset(&mut self) {
        self.input.release();
        self.previous = None;
    }

    pub fn set_audio(&mut self, context: AudioContext) {
        self.audio = Some(context);
    }
}
