# [slopgrid](https://slopgrid.com) [![CI](https://github.com/klntsky/slopgrid/actions/workflows/ci.yml/badge.svg?branch=master)](https://github.com/klntsky/slopgrid/actions/workflows/ci.yml)

[Slopgrid](https://slopgrid.com) lets you compare AI-generated outputs side by side. Build a grid of models, thinking efforts, or prompt variations, then watch them produce Markdown, images, SVG, or static websites using your OpenRouter account.

[![A Slopgrid comparison of SVG outputs across models and thinking efforts](docs/images/grid.png)](https://slopgrid.com/grid/e32b0dba878a2681035fd200b02019eae717496414a35181)

## Useful features

- Allows you to limit inference spending in USD per inference call;
- Tries to prevent hitting inference budget limits by pre-checking your openrouter allowance and running as many parallel inferences as possible, with some safety margin
- Easy sharing and collaboration via forking; your data is private by default; deletion of public grids is impossible on purpose - we don't want important benchmark data to disappear

## Supported grid layouts

The user defines what columns and rows of a grid mean;

### Image outputs

- Models
- Prompt variables
- Image sizes, including custom pixel dimensions
- Aspect ratios
- Quality levels
- Backgrounds: automatic, transparent, or opaque
- Groups of input reference images

### SVG, Markdown, and Website outputs

- Models
- Thinking efforts
- Prompt variables
