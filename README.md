# druid web

A web-based editor and REPL for [monome crow](https://github.com/monome/crow) and compatible devices like [blackbird](https://github.com/TomWhitwell/Workshop_Computer) using the Web Serial API. Inspired by [maiden](https://github.com/monome/maiden), the norns web editor.

## Overview

**druid web** provides a browser-based interface for writing, editing, and running Lua scripts on crow devices over USB. It features a split-screen layout with a Monaco code editor on the left and an output/input REPL on the right, similar to maiden's interface.

## Browser Requirements

**druid web requires a Chromium-based browser** that supports the Web Serial API:

- ✅ Google Chrome (version 89+)
- ✅ Microsoft Edge (version 89+)
- ✅ Opera (version 75+)
- ❌ Firefox (not yet supported)
- ❌ Safari (not yet supported)

## Limitations

Compared to the command-line version, druid web has some limitations:

### Not Supported
- **Firmware updates** - DFU mode requires native USB access
- **WebSocket server** - The command-line druid can act as a WebSocket bridge
- **Auto-discovery** - You must manually select the crow device each time

### Browser Restrictions
- Must grant permission for each session (security requirement)
- HTTPS required for non-localhost deployments
- Limited to Chromium-based browsers


## Local Setup for Development

### Installation

First, install the required npm packages:

```bash
npm install
```

This will install:
- `monaco-editor` - The code editor
- `luaparse` - Lua syntax parsing

### Running Locally

Serve the files with a local HTTP server:

```bash
# Python 3
python3 -m http.server 8000

# Python 2
python -m SimpleHTTPServer 8000

# Node.js (if you have http-server installed)
npx http-server -p 8000
```

Then open `http://localhost:8000` in your browser.

## Deployment

To deploy druid web:

1. Ensure your repository includes `package.json` and `package-lock.json`
2. Push to the `deploy` branch to trigger the GitHub Actions workflow
3. The workflow will automatically:
   - Install npm dependencies (`monaco-editor` and `luaparse`)
   - Deploy to GitHub Pages with HTTPS

The site will be available at your GitHub Pages URL.

Note: HTTPS is required for the Web Serial API to work in production.

## Development

The project uses:
- **Monaco Editor** - Code editor (installed via npm)
- **luaparse** - Lua syntax parsing (installed via npm)

Main files:
- `index.html` - HTML structure and layout
- `druid.js` - Web Serial API integration and REPL logic
- `style.css` - Styling and theme
- `package.json` - npm dependencies
- `.github/workflows/deploy.yml` - GitHub Actions deployment workflow

### Architecture

**CrowConnection class:**
- Manages Web Serial API connection
- Handles reading/writing to serial port
- Provides callbacks for data and connection events

**DruidRepl class:**
- Main application controller
- Handles UI interactions
- Processes commands and manages REPL state
- Coordinates file uploads and script execution

## Troubleshooting

### "Browser Not Supported" Error
Make sure you're using Chrome, Edge, or Opera (version 89+).

### Can't Find crow Device
- Verify crow is connected via USB
- Check that crow appears in your system's device list
- Try a different USB cable or port
- On Linux, you may need udev rules (same as command-line druid)

### Connection Drops
- Check USB cable connection
- Verify crow hasn't crashed (LED should be blinking)
- Click "Disconnect" then "Connect to crow" to reconnect

### Permission Denied
The browser requires explicit user permission to access serial ports. You must click the "Connect to crow" button and select the device from the picker each time you load the page.

## License

Same as druid - see LICENSE file in the repository root.
