// Import necessary modules and dependencies
import axios, { AxiosRequestConfig } from "axios";
import fs from "fs";
import path from "path";
import FormData from "form-data";
import { Wallet, DataStore } from "../blockchain";
import { getOrCreateSSLCerts } from "../utils/ssl";
import { promptCredentials } from "../utils/credentialsUtils";
import https from "https";
import cliProgress from "cli-progress";
import { green, red, blue, yellow } from "colorette";
import { STORE_PATH } from "../utils/config";
import { getFilePathFromSha256 } from "../utils/hashUtils";
import { createSpinner } from "nanospinner";
import ProgressStream from "progress-stream";

// Helper function to trim long filenames with ellipsis and ensure consistent padding
function formatFilename(filename: string | undefined, maxLength = 30): string {
  if (!filename) {
    return "Unknown File".padEnd(maxLength, " ");
  }

  if (filename.length > maxLength) {
    return `...${filename.slice(-(maxLength - 3))}`.padEnd(maxLength, " ");
  }
  return filename.padEnd(maxLength, " ");
}

export class PropagationServer {
  storeId: string;
  sessionId: string;
  publicKey: string;
  wallet: any;
  ipAddress: string;
  certPath: string;
  keyPath: string;
  username: string | undefined;
  password: string | undefined;

  private static readonly port = 4159; // Static port used for all requests

  constructor(ipAddress: string, storeId: string) {
    this.storeId = storeId;
    this.sessionId = "";
    this.publicKey = "";
    this.ipAddress = ipAddress;

    // Get or create SSL certificates
    const { certPath, keyPath } = getOrCreateSSLCerts();
    this.certPath = certPath;
    this.keyPath = keyPath;
  }

  /**
   * Initialize the Wallet instance.
   */
  async initializeWallet() {
    this.wallet = await Wallet.load("default");
    this.publicKey = (
      await this.wallet.getPublicSyntheticKey()
    ).toString("hex");
  }

  /**
   * Create an Axios HTTPS Agent with self-signed certificate allowance.
   */
  createHttpsAgent() {
    return new https.Agent({
      cert: fs.readFileSync(this.certPath),
      key: fs.readFileSync(this.keyPath),
      rejectUnauthorized: false,
    });
  }

  /**
   * Check if the store and optional root hash exist by making a HEAD request.
   */
  async checkStoreExists(
    rootHash?: string
  ): Promise<{ storeExists: boolean; rootHashExists: boolean }> {
    const spinner = createSpinner(
      `Checking if store ${this.storeId} exists...`
    ).start();
    try {
      const config: AxiosRequestConfig = {
        httpsAgent: this.createHttpsAgent(),
      };

      let url = `https://${this.ipAddress}:${PropagationServer.port}/${this.storeId}`;
      if (rootHash) {
        url += `?hasRootHash=${rootHash}`;
      }

      const response = await axios.head(url, config);

      // Extract store existence and root hash existence from headers
      const storeExists = response.headers["x-store-exists"] === "true";
      const rootHashExists = response.headers["x-has-root-hash"] === "true";

      if (storeExists) {
        spinner.success({
          text: green(`Store ${this.storeId} exists on peer!`),
        });
      } else {
        spinner.error({
          text: red(
            `Store ${this.storeId} does not exist. Credentials will be required to push.`
          ),
        });
      }

      return { storeExists, rootHashExists };
    } catch (error: any) {
      spinner.error({ text: red("Error checking if store exists:") });
      console.error(red(error.message));
      throw error;
    }
  }

  /**
   * Start an upload session by sending a POST request with the rootHash.dat file.
   */
  async startUploadSession(rootHash: string) {
    const spinner = createSpinner(
      `Starting upload session for store ${this.storeId}...`
    ).start();

    try {
      const formData = new FormData();
      const datFilePath = path.join(STORE_PATH, this.storeId, `${rootHash}.dat`);

      // Ensure the rootHash.dat file exists
      if (!fs.existsSync(datFilePath)) {
        throw new Error(`File not found: ${datFilePath}`);
      }

      formData.append("file", fs.createReadStream(datFilePath), {
        filename: `${rootHash}.dat`,
      });

      const config: AxiosRequestConfig = {
        httpsAgent: this.createHttpsAgent(),
        headers: {
          ...formData.getHeaders(),
        },
      };

      // Add Basic Auth if username and password are present
      if (this.username && this.password) {
        config.auth = {
          username: this.username,
          password: this.password,
        };
      }

      const url = `https://${this.ipAddress}:${PropagationServer.port}/upload/${this.storeId}?roothash=${rootHash}`;
      const response = await axios.post(url, formData, config);

      this.sessionId = response.data.sessionId;
      spinner.success({
        text: green(
          `Upload session started for DataStore ${this.storeId} with session ID ${this.sessionId}`
        ),
      });
    } catch (error: any) {
      spinner.error({ text: red("Error starting upload session:") });
      console.error(red(error.message));
      throw error;
    }
  }

  /**
   * Request a nonce for a file by sending a HEAD request to the server.
   */
  async getFileNonce(
    filename: string
  ): Promise<{ nonce: string; fileExists: boolean }> {
    try {
      const config: AxiosRequestConfig = {
        httpsAgent: this.createHttpsAgent(),
      };

      const url = `https://${this.ipAddress}:${PropagationServer.port}/upload/${this.storeId}/${this.sessionId}/${filename}`;
      const response = await axios.head(url, config);

      // Check for 'x-file-exists' header
      const fileExists = response.headers["x-file-exists"] === "true";

      // If file exists, no need to generate a nonce
      const nonce = response.headers["x-nonce"];

      return { nonce, fileExists };
    } catch (error: any) {
      console.error(
        red(`Error generating nonce for file ${filename}:`),
        error.message
      );
      throw error;
    }
  }

  /**
   * Upload a file to the server by sending a PUT request.
   * Logs progress using a local cli-progress bar.
   */
  async uploadFile(label: string, dataPath: string) {
    const filePath = path.join(STORE_PATH, this.storeId, dataPath);

    const { nonce, fileExists } = await this.getFileNonce(dataPath);

    if (fileExists) {
      console.log(blue(`File ${label} already exists. Skipping upload.`));
      return;
    }

    const wallet = await Wallet.load("default");
    const keyOwnershipSig = await wallet.createKeyOwnershipSignature(nonce);
    const publicKey = await wallet.getPublicSyntheticKey();

    // Get the file size
    const fileSize = fs.statSync(filePath).size;

    let progressBar: cliProgress.SingleBar | undefined;

    try {
      // Create a new progress bar for the file
      progressBar = new cliProgress.SingleBar(
        {
          format: `${blue('[{bar}]')} | ${yellow('{filename}')} | {percentage}% | {value}/{total} bytes`,
          hideCursor: true,
          barsize: 30,
          align: "left",
          autopadding: true,
          noTTYOutput: false,
          stopOnComplete: true,
          clearOnComplete: false,
        },
        cliProgress.Presets.legacy
      );

      progressBar.start(fileSize, 0, {
        filename: formatFilename(path.basename(label)),
      });

      // Create a progress stream
      const progressStream = ProgressStream({
        length: fileSize,
        time: 500, // Adjust as needed
      });

      progressStream.on("progress", (progress) => {
        progressBar!.update(progress.transferred);
      });

      // Create a read stream and pipe it through the progress stream
      const fileReadStream = fs
        .createReadStream(filePath)
        .pipe(progressStream);

      // Use form-data to construct the request body
      const formData = new FormData();
      formData.append("file", fileReadStream);

      const headers = {
        ...formData.getHeaders(),
        "x-nonce": nonce,
        "x-public-key": publicKey.toString("hex"),
        "x-key-ownership-sig": keyOwnershipSig,
      };

      const config: AxiosRequestConfig = {
        headers: headers,
        httpsAgent: this.createHttpsAgent(),
        maxContentLength: Infinity,
        maxBodyLength: Infinity,
      };

      const url = `https://${this.ipAddress}:${PropagationServer.port}/upload/${this.storeId}/${this.sessionId}/${dataPath}`;
      const response = await axios.put(url, formData, config);

      // Wait for the progress stream to finish
      await new Promise<void>((resolve, reject) => {
        progressStream.on("end", resolve);
        progressStream.on("error", reject);
      });
    } catch (error: any) {
      throw error;
    } finally {
      if (progressBar) {
        progressBar.stop();
      }
    }
  }

  /**
   * Commit the upload session by sending a POST request to the server.
   */
  async commitUploadSession() {
    const spinner = createSpinner(
      `Committing upload session for store ${this.storeId}...`
    ).start();

    try {
      const config: AxiosRequestConfig = {
        httpsAgent: this.createHttpsAgent(),
        auth:
          this.username && this.password
            ? {
                username: this.username,
                password: this.password,
              }
            : undefined,
      };

      const url = `https://${this.ipAddress}:${PropagationServer.port}/commit/${this.storeId}/${this.sessionId}`;
      const response = await axios.post(url, {}, config);

      spinner.success({
        text: green(`Upload session ${this.sessionId} successfully committed.`),
      });

      return response.data;
    } catch (error: any) {
      spinner.error({ text: red("Error committing upload session:") });
      console.error(red(error.message));
      throw error;
    }
  }

  /**
   * Static function to handle the entire upload process for multiple files based on rootHash.
   */
  static async uploadStore(
    storeId: string,
    rootHash: string,
    ipAddress: string
  ) {
    const propagationServer = new PropagationServer(ipAddress, storeId);

    // Initialize wallet
    await propagationServer.initializeWallet();

    // Check if the store exists
    const { storeExists, rootHashExists } =
      await propagationServer.checkStoreExists(rootHash);

    // If the store does not exist, prompt for credentials
    if (!storeExists) {
      console.log(
        red(`Store ${storeId} does not exist. Prompting for credentials...`)
      );
      const credentials = await promptCredentials(propagationServer.ipAddress);
      propagationServer.username = credentials.username;
      propagationServer.password = credentials.password;
    }

    if (rootHashExists) {
      console.log(
        blue(
          `Root hash ${rootHash} already exists in the store. Skipping upload.`
        )
      );
      return;
    }

    // Start the upload session
    await propagationServer.startUploadSession(rootHash);

    const dataStore = DataStore.from(storeId);
    const files = await dataStore.getFileSetForRootHash(rootHash);

    // Prepare upload tasks
    const uploadTasks = files.map((file) => ({
      label: file.name,
      dataPath: file.path,
    }));

    // Limit the number of concurrent uploads
    const concurrencyLimit = 3; // Adjust this number as needed

    // Import asyncPool from your utilities
    const { asyncPool } = await import("../utils/asyncPool");

    await asyncPool(concurrencyLimit, uploadTasks, async (task) => {
      await propagationServer.uploadFile(task.label, task.dataPath);
    });

    // Commit the session after all files have been uploaded
    await propagationServer.commitUploadSession();

    console.log(
      green(`✔ All files have been uploaded to DataStore ${storeId}.`)
    );
  }

  /**
   * Fetch a file from the server by sending a GET request and return its content in memory.
   * Logs progress using a local cli-progress bar.
   */
  async fetchFile(dataPath: string): Promise<Buffer> {
    const url = `https://${this.ipAddress}:${PropagationServer.port}/fetch/${this.storeId}/${dataPath}`;
    const config: AxiosRequestConfig = {
      responseType: "stream",
      httpsAgent: this.createHttpsAgent(),
    };

    let progressBar: cliProgress.SingleBar | undefined;

    try {
      const response = await axios.get(url, config);
      const totalLengthHeader = response.headers["content-length"];
      const totalLength = totalLengthHeader
        ? parseInt(totalLengthHeader, 10)
        : null;

      if (!totalLength) {
        throw new Error("Content-Length header is missing");
      }

      // Create a new progress bar for the file
      progressBar = new cliProgress.SingleBar(
        {
          format: `${blue('[{bar}]')} | ${yellow('{filename}')} | {percentage}% | {value}/{total} bytes`,
          hideCursor: true,
          barsize: 30,
          align: "left",
          autopadding: true,
          noTTYOutput: false,
          stopOnComplete: true,
          clearOnComplete: false,
        },
        cliProgress.Presets.legacy
      );

      progressBar.start(totalLength, 0, {
        filename: formatFilename(dataPath),
      });

      let dataBuffers: Buffer[] = [];

      const progressStream = ProgressStream({
        length: totalLength,
        time: 500, // Adjust as needed
      });

      progressStream.on("progress", (progress) => {
        progressBar!.update(progress.transferred);
      });

      response.data.pipe(progressStream);

      progressStream.on("data", (chunk: Buffer) => {
        dataBuffers.push(chunk);
      });

      // Wait for the progress stream to finish
      await new Promise<void>((resolve, reject) => {
        progressStream.on("end", resolve);
        progressStream.on("error", reject);
      });

      return Buffer.concat(dataBuffers);
    } catch (error) {
      throw error;
    } finally {
      if (progressBar) {
        progressBar.stop();
      }
    }
  }

  /**
   * Get details of a file, including whether it exists and its size.
   */
  async getFileDetails(
    dataPath: string,
    rootHash: string
  ): Promise<{ exists: boolean; size: number }> {
    try {
      const config: AxiosRequestConfig = {
        httpsAgent: this.createHttpsAgent(),
      };

      const url = `https://${this.ipAddress}:${PropagationServer.port}/store/${this.storeId}/${rootHash}/${dataPath}`;
      const response = await axios.head(url, config);

      // Check the headers for file existence and size
      const fileExists = response.headers["x-file-exists"] === "true";
      const fileSize = parseInt(response.headers["x-file-size"], 10);

      return {
        exists: fileExists,
        size: fileExists ? fileSize : 0,
      };
    } catch (error: any) {
      console.error(
        red(`✖ Error checking file details for ${dataPath}:`),
        error.message
      );
      throw error;
    }
  }

  /**
   * Download a file from the server by sending a GET request.
   * Logs progress using a local cli-progress bar.
   */
  async downloadFile(label: string, dataPath: string) {
    const url = `https://${this.ipAddress}:${PropagationServer.port}/fetch/${this.storeId}/${dataPath}`;
    const downloadPath = path.join(STORE_PATH, this.storeId, dataPath);

    // Ensure that the directory for the file exists
    fs.mkdirSync(path.dirname(downloadPath), { recursive: true });

    const config: AxiosRequestConfig = {
      responseType: "stream",
      httpsAgent: this.createHttpsAgent(),
    };

    let progressBar: cliProgress.SingleBar | undefined;

    try {
      const response = await axios.get(url, config);
      const totalLengthHeader = response.headers["content-length"];
      const totalLength = totalLengthHeader
        ? parseInt(totalLengthHeader, 10)
        : null;

      if (!totalLength) {
        throw new Error("Content-Length header is missing");
      }

      // Create a new progress bar for the file
      progressBar = new cliProgress.SingleBar(
        {
          format: `${blue('[{bar}]')} | ${yellow('{filename}')} | {percentage}% | {value}/{total} bytes`,
          hideCursor: true,
          barsize: 30,
          align: "left",
          autopadding: true,
          noTTYOutput: false,
          stopOnComplete: true,
          clearOnComplete: false,
        },
        cliProgress.Presets.legacy
      );

      progressBar.start(totalLength, 0, {
        filename: formatFilename(label),
      });

      const fileWriteStream = fs.createWriteStream(downloadPath);

      const progressStream = ProgressStream({
        length: totalLength,
        time: 500, // Adjust as needed
      });

      progressStream.on("progress", (progress) => {
        progressBar!.update(progress.transferred);
      });

      response.data.pipe(progressStream).pipe(fileWriteStream);

      // Wait for both the file write stream and the progress stream to finish
      await Promise.all([
        new Promise<void>((resolve, reject) => {
          fileWriteStream.on("finish", resolve);
          fileWriteStream.on("error", reject);
        }),
        new Promise<void>((resolve, reject) => {
          progressStream.on("end", resolve);
          progressStream.on("error", reject);
        }),
      ]);
    } catch (error) {
      throw error;
    } finally {
      if (progressBar) {
        progressBar.stop();
      }
    }
  }

  /**
   * Static function to handle downloading multiple files from a DataStore based on file paths.
   */
  static async downloadStore(
    storeId: string,
    rootHash: string,
    ipAddress: string
  ) {
    const propagationServer = new PropagationServer(ipAddress, storeId);

    // Initialize wallet
    await propagationServer.initializeWallet();

    // Check if the store exists
    const { storeExists, rootHashExists } =
      await propagationServer.checkStoreExists(rootHash);
    if (!storeExists || !rootHashExists) {
      throw new Error(`Store ${storeId} does not exist.`);
    }

    // Fetch the rootHash.dat file
    const datFileContent = await propagationServer.fetchFile(
      `${rootHash}.dat`
    );
    const root = JSON.parse(datFileContent.toString());

    // Prepare download tasks
    const downloadTasks = [];

    for (const [fileKey, fileData] of Object.entries(root.files)) {
      const dataPath = getFilePathFromSha256(
        (fileData as any).sha256,
        "data"
      );

      const label = Buffer.from(fileKey, "hex").toString("utf-8");

      downloadTasks.push({ label, dataPath });
    }

    // Limit the number of concurrent downloads
    const concurrencyLimit = 5; // Adjust this number as needed

    // Import asyncPool from your utilities
    const { asyncPool } = await import("../utils/asyncPool");

    await asyncPool(concurrencyLimit, downloadTasks, async (task) => {
      await propagationServer.downloadFile(task.label, task.dataPath);
    });

    // Save the rootHash.dat file
    fs.writeFileSync(
      path.join(STORE_PATH, storeId, `${rootHash}.dat`),
      datFileContent
    );

    const dataStore = DataStore.from(storeId);
    await dataStore.generateManifestFile();

    console.log(green(`✔ All files have been downloaded to ${storeId}.`));
  }
}
