# PRISM Client Extension

PRISM Client Extension is a browser extension project that requires the provided model files to be placed in the repository before building the extension.

## Requirements

Before starting, make sure you have:

* Git
* Node.js
* npm
* The PRISM model ZIP file

---

## 1. Clone the Repository

Clone the repository and enter the project directory:

```bash
git clone https://github.com/maskmasteruk/PRISM_CLIENT_EXTENSION.git
cd PRISM_CLIENT_EXTENSION
```

---

## 2. Download the Models

Download the **models ZIP file** from the following Google Drive link:

https://drive.google.com/file/d/1edXPx3e3CzdTXfa4yG7tSJcHLUWBXQPh/view?usp=sharing

The downloaded file contains the `models` folder required by the extension.

---

## 3. Extract the Models

Extract the downloaded ZIP file.

After extraction, make sure the directory structure places the `models` folder directly in the **root directory of the repository**.

The project should look approximately like:

```text
PRISM_CLIENT_EXTENSION/
│
├── models/
│   ├── ...
│   └── ...
│
├── src/
│   └── ...
│
├── package.json
├── package-lock.json
├── ...
└── README.md
```

### Important

The `models` directory must be located at:

```text
PRISM_CLIENT_EXTENSION/models/
```

Do **not** place it inside another nested directory such as:

```text
PRISM_CLIENT_EXTENSION/models/models/
```

or:

```text
PRISM_CLIENT_EXTENSION/download/models/
```

The `models` folder should be directly under the repository root.

---

## 4. Install Dependencies

Once the repository has been cloned and the `models` folder has been extracted into the correct location, install the project dependencies:

```bash
npm i
```

This installs the dependencies specified in `package.json`.

---

## 5. Build the Extension

After the dependencies have been installed, build the extension:

```bash
npm run build
```

The build process will generate the production-ready browser extension files according to the project's build configuration.

---

## Complete Setup

The complete setup process is:

```bash
# Clone the repository
git clone https://github.com/maskmasteruk/PRISM_CLIENT_EXTENSION.git

# Enter the repository
cd PRISM_CLIENT_EXTENSION

# Download the models ZIP from Google Drive
# Extract it so that:
# PRISM_CLIENT_EXTENSION/models/

# Install dependencies
npm i

# Build the extension
npm run build
```

---

## Expected Project Structure

Before running the build, verify that the `models` folder exists at the repository root:

```text
PRISM_CLIENT_EXTENSION/
│
├── models/
│   ├── model files...
│   └── ...
│
├── src/
│   └── ...
│
├── package.json
├── package-lock.json
└── ...
```

The important requirement is:

```text
models/
```

must be directly inside the project root.

---

## Build Workflow

```text
Clone Repository
       │
       ▼
Download Models ZIP
       │
       ▼
Extract ZIP
       │
       ▼
Place models/ in Repository Root
       │
       ▼
      npm i
       │
       ▼
  npm run build
       │
       ▼
Production Build
```

---

## Troubleshooting

### `npm` is not recognized

Make sure Node.js and npm are installed and available in your system PATH.

Verify the installation:

```bash
node --version
npm --version
```

---

### Models are not found

Verify that the models directory exists directly inside the repository:

```text
PRISM_CLIENT_EXTENSION/models/
```

If the ZIP extraction created an additional directory, move the actual `models` folder to the repository root.

---

### Incorrect directory structure

Avoid structures such as:

```text
PRISM_CLIENT_EXTENSION/
└── models.zip
```

or:

```text
PRISM_CLIENT_EXTENSION/
└── extracted/
    └── models/
```

The required structure is:

```text
PRISM_CLIENT_EXTENSION/
└── models/
```

---

## Quick Start

```bash
git clone https://github.com/maskmasteruk/PRISM_CLIENT_EXTENSION.git
cd PRISM_CLIENT_EXTENSION

# Extract the downloaded models ZIP here
# Ensure ./models exists

npm i
npm run build
```

After a successful build, the generated extension can be loaded into the appropriate browser as an unpacked extension, depending on the browser and build configuration.
