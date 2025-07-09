import { ESPLoader, Transport } from "https://unpkg.com/esptool-js@0.5.4/bundle.js";

const FLASH_BAUD_RATE = 921600; // Baud rate for flashing
const TERM_BAUD_RATE = 115200;  // Baud rate for terminal
const FLASH_OFFSET = 0x0;

const log = document.getElementById("log");
const butConnect = document.getElementById("butConnect");
const butProgram = document.getElementById("butProgram");
const butTerminal = document.getElementById("butTerminal");
const firmwareSelect = document.getElementById("firmwareSelect");

let device = null;
let transport = null;
let esploader = null;
let port = null;
let reader = null;
let isMonitoring = false;
let buffer = "";
let progressLine = null;

const availableFirmware = [
    "firmware/ideaboard-experimental-BLE.bin"
];

document.addEventListener("DOMContentLoaded", () => {
    butConnect.addEventListener("click", clickConnect);
    butProgram.addEventListener("click", clickProgram);
    butTerminal.addEventListener("click", clickTerminal);

    if ("serial" in navigator) {
        document.getElementById("notSupported").style.display = "none";
    }

    availableFirmware.forEach(firmware => {
        const option = document.createElement("option");
        option.value = firmware;
        option.textContent = firmware.split('/').pop();
        firmwareSelect.appendChild(option);
    });

    logLine("Ideaboard Flasher & Terminal loaded.");

    // Add this new event listener
    document.getElementById("noDeviceLink").addEventListener("click", (e) => {
        e.preventDefault();
        const driverInfo = document.getElementById("driverInfo");
        driverInfo.style.display = driverInfo.style.display === "none" ? "block" : "none";
    });
});

function logLine(text) {
    if (text.startsWith("Programming: ") || text.startsWith("Writing at")) {
        if (!progressLine) {
            progressLine = document.createElement("div");
            log.appendChild(progressLine);
        }
        progressLine.textContent = text;
    } else {
        const line = document.createElement("div");
        line.textContent = text;
        log.appendChild(line);
    }
    log.scrollTop = log.scrollHeight;
}

function logError(text) {
    const line = document.createElement("div");
    line.innerHTML = `<span style="color: red;">Error: ${text}</span>`;
    log.appendChild(line);
    log.scrollTop = log.scrollHeight;
}

async function clickConnect() {
    if (transport || port) {
        // If already connected, disconnect
        if (isMonitoring) await stopMonitoring();
        else {
            // If not monitoring, manually disconnect transport
            if (transport) {
                await transport.disconnect();
                transport = null;
            }
            // Port might still be open if not monitoring
            if (port && port.readable) {
                await port.close();
            }
            device = null;
            port = null;
            toggleUI(false);
            logLine("Disconnected from serial port.");
        }
        return;
    }

    try {
        device = await navigator.serial.requestPort({});
        port = device; // Reuse the same port for terminal
        transport = new Transport(device, true);
        toggleUI(true);
        logLine("Connected to serial port.");
    } catch (e) {
        logError(`Failed to connect: ${e.message}`);
        toggleUI(false);
    }
}

async function clickProgram() {
    if (!transport) {
        logError("Please connect to a serial port first.");
        return;
    }

    const selectedFirmware = firmwareSelect.value;
    if (!selectedFirmware) {
        logError("Please select a firmware file first.");
        return;
    }

    if (!confirm("This will erase and program the flash. Continue?")) return;

    butProgram.disabled = true;
    progressLine = null;
    try {
        const loaderOptions = {
            transport: transport,
            baudrate: FLASH_BAUD_RATE,
            terminal: {
                clean: () => (log.innerHTML = ""),
                writeLine: (data) => logLine(data),
                write: (data) => logLine(data),
            },
        };
        esploader = new ESPLoader(loaderOptions);
        await esploader.main("default_reset");
        logLine("Erasing flash...");
        const eraseStart = Date.now();
        await esploader.eraseFlash();
        logLine(`Erase completed in ${Date.now() - eraseStart}ms.`);

        logLine("Fetching firmware...");
        const response = await fetch(selectedFirmware);
        if (!response.ok) throw new Error("Failed to fetch firmware");
        const arrayBuffer = await response.arrayBuffer();
        const firmwareData = arrayBufferToBinaryString(arrayBuffer);

        const flashOptions = {
            fileArray: [{ data: firmwareData, address: FLASH_OFFSET }],
            flashSize: "keep",
            eraseAll: false,
            compress: true,
            reportProgress: () => {},
            calculateMD5Hash: (image) => CryptoJS.MD5(CryptoJS.enc.Latin1.parse(image)),
        };

        logLine(`Programming firmware at offset 0x${FLASH_OFFSET.toString(16)}...`);
        const programStart = Date.now();
        await esploader.writeFlash(flashOptions);
        logLine(`Programming completed in ${Date.now() - programStart}ms.`);
        logLine("Firmware installed successfully. Click Terminal and reset your device.");
    } catch (e) {
        logError(e.message);
    } finally {
        butProgram.disabled = false;
        if (transport) {
            await transport.disconnect();
            transport = null;
        }
        if (port && port.readable) {
            await port.close();
            port = null;
        }
        esploader = null;
    }
}

async function clickTerminal() {
    if (isMonitoring) {
        await stopMonitoring();
        return;
    }

    if (!port) {
        logError("Please connect to a serial port first.");
        return;
    }

    try {
        logLine("Reset your device now, waiting 2 seconds...");
        await sleep(2000); // Wait for manual reset
        await port.open({ baudRate: TERM_BAUD_RATE });
        logLine(`Terminal started at ${TERM_BAUD_RATE} baud. Click Stop to end.`);

        isMonitoring = true;
        butTerminal.textContent = "Stop";
        butTerminal.style.backgroundColor = "#e74c3c";
        log.innerHTML = "";
        buffer = "";

        const decoder = new TextDecoder();
        reader = port.readable.getReader();

        while (isMonitoring) {
            try {
                const { value, done } = await reader.read();
                if (done) {
                    if (buffer) {
                        const cleanedBuffer = cleanSerialOutput(buffer);
                        if (cleanedBuffer) logLine(cleanedBuffer);
                        buffer = "";
                    }
                    logLine("Serial stream ended.");
                    break;
                }
                const text = decoder.decode(value);
                buffer += text;

                let newlineIndex;
                while ((newlineIndex = buffer.indexOf('\n')) !== -1) {
                    const line = buffer.substring(0, newlineIndex);
                    const cleanedLine = cleanSerialOutput(line);
                    if (cleanedLine) logLine(cleanedLine);
                    buffer = buffer.substring(newlineIndex + 1);
                }
            } catch (e) {
                if (e.message.includes("device has been lost")) {
                    logError("Device lost, please reconnect and try again.");
                    break;
                }
                throw e; // Rethrow other errors
            }
        }
    } catch (e) {
        logError(`Terminal failed: ${e.message}`);
    } finally {
        if (isMonitoring) await stopMonitoring();
    }
}

async function stopMonitoring() {
    isMonitoring = false;
    butTerminal.textContent = "Terminal";
    butTerminal.style.backgroundColor = "";

    if (reader) {
        await reader.cancel();
        if (typeof reader.releaseLock === 'function') reader.releaseLock();
        reader = null;
    }

    if (port && port.readable) {
        await port.close();
    }
    // Reset port and device state
    port = null;
    device = null;
    // Update UI to reflect disconnected state
    toggleUI(false);
    logLine("Terminal stopped.");
}

function cleanSerialOutput(text) {
    text = text.replace(/\x1B\[[0-9;]*[a-zA-Z]/g, '')
               .replace(/\x1B\]0;.*?\x07/g, '')
               .replace(/\x1B\]0;.*?\x5C/g, '')
               .replace(/\x1B\]0;.*?[\x07\x5C]/g, '')
               .replace(/[\x00-\x09\x0B-\x1F\x7F-\x9F]/g, '')
               .replace(/\r\n/g, '\n').replace(/\r/g, '');
    return text;
}

function toggleUI(connected) {
    butConnect.textContent = connected ? "Disconnect" : "Connect";
    butProgram.disabled = !connected;
    butTerminal.disabled = !connected;
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function arrayBufferToBinaryString(arrayBuffer) {
    const bytes = new Uint8Array(arrayBuffer);
    let binaryString = "";
    for (let i = 0; i < bytes.length; i++) {
        binaryString += String.fromCharCode(bytes[i]);
    }
    return binaryString;
}