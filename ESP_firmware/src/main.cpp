/* Freenove WROVER camera + TaskPet Link v1 display/sensor bridge.
   IMPORTANT: original wiring conflicts with camera. See REWIRING.txt.
   Paste credentials in a local secrets.h copied from secrets.example.h.
   WebSocket: ws://DEVICE_IP:81/ ; first text message: AUTH <device token>
   Raw RGB565 little-endian 240x320 pixels, delivered in ordered strips.
   See PROTOCOL.txt and the dependency-free JavaScript client.
*/
#include <Arduino.h>
void statusScreen(const char *line);
void haltWithMessage(const char *message);
#include <SPI.h>
#include <Wire.h>
#include <WiFi.h>
#include <ESPmDNS.h>
#include <Preferences.h>
#include <WebSocketsServer.h>
#include <Adafruit_GFX.h>
#include <Adafruit_ST7789.h>
#include <Adafruit_MPU6050.h>
#include <Adafruit_BME280.h>
#include <Adafruit_BMP280.h>
#include <esp_heap_caps.h>
// The camera driver and Adafruit Unified Sensor both define global sensor_t.
// Rename only the camera header's type locally; C driver symbols stay unchanged.
#define sensor_t camera_sensor_t
#include <esp_camera.h>
#undef sensor_t
#include <esp_http_server.h>
#include <sdkconfig.h>
#include <atomic>
#include <math.h>
#include <initializer_list>
#if __has_include("secrets.h")
#include "secrets.h"
#else
#include "secrets.example.h"
#endif

// Defaults are empty. A flashable build can be configured over USB serial;
// credentials are stored locally in the device's NVS, never printed.
char deviceWifiSSID[33]=LINK_WIFI_SSID;
char deviceWifiPassword[65]=LINK_WIFI_PASSWORD;
char deviceToken[129]=LINK_DEVICE_TOKEN;

constexpr int TFT_MOSI=13, TFT_SCLK=14, TFT_CS=15, TFT_DC=2, TFT_RST=-1, TFT_BL=-1;
// Both external sensors now SHARE SDA32/SCL33. Camera has its own SCCB bus.
constexpr int SENSOR_SDA=32, SENSOR_SCL=33, BUTTON_PIN=-1;
constexpr bool BUTTON_ENABLED=false, BACKLIGHT_ACTIVE_HIGH=true;
constexpr uint8_t DISPLAY_ROTATION=0; // Portrait only: 0 or 2.
constexpr bool DISPLAY_INVERT=true;
constexpr uint32_t TFT_SPI_HZ=20000000;
constexpr size_t WIDTH=240, HEIGHT=320, FRAME_BYTES=WIDTH*HEIGHT*2;
constexpr uint16_t MAX_STRIP_ROWS=16;
constexpr uint32_t FRAME_TIMEOUT_MS=2000, AUTH_TIMEOUT_MS=5000;

Adafruit_ST7789 tft(&SPI,TFT_CS,TFT_DC,TFT_RST);
// Select the controller not reserved by the bundled camera driver's SCCB config.
#if defined(CONFIG_SCCB_HARDWARE_I2C_PORT1) && CONFIG_SCCB_HARDWARE_I2C_PORT1
constexpr uint8_t SENSOR_I2C_CONTROLLER=0;
#else
constexpr uint8_t SENSOR_I2C_CONTROLLER=1;
#endif
TwoWire SensorWire(SENSOR_I2C_CONTROLLER);
Adafruit_MPU6050 mpu;
Adafruit_BME280 bme;
Adafruit_BMP280 bmp(&SensorWire);
WebSocketsServer socketServer(81);
uint16_t *framebuffer=nullptr;
int owner=-1;
bool pendingAuth[WEBSOCKETS_SERVER_CLIENT_MAX]={};
uint32_t authStarted[WEBSOCKETS_SERVER_CLIENT_MAX]={};
bool frameActive=false, frameEverShown=false;
uint32_t receivingId=0, lastFrameId=0, stripTime=0, frameCount=0;
uint16_t nextRow=0;
uint32_t lastMotion=0,lastEnv=0,lastTelemetry=0,lastRetry=0,lastLog=0;
uint32_t motionTime=0,envTime=0,sensorSequence=0;
uint8_t mpuAddress=0,envAddress=0,envKind=0;
bool imuValid=false,envValid=false,buttonPressed=false;
uint32_t buttonPressCount=0;
float ax=NAN,ay=NAN,az=NAN,gx=NAN,gy=NAN,gz=NAN;
float mpuTemperature=NAN,rollDeg=NAN,pitchDeg=NAN;
float temperatureC=NAN,pressureHpa=NAN,humidityPct=NAN;
String hostname;
bool cameraReady=false;
esp_err_t cameraInitResult=ESP_FAIL;
httpd_handle_t cameraHttp=nullptr;
std::atomic<uint32_t> cameraFrames{0};
portMUX_TYPE sensorCacheLock=portMUX_INITIALIZER_UNLOCKED;
char sensorCache[1600]="{\"type\":\"sensors\",\"status\":\"starting\"}";
constexpr uint32_t CAMERA_INTERVAL_MS=200; // Target 5 fps; not guaranteed.

String readSetupLine() {
  String line; line.reserve(129); bool overflow=false;
  while(true) {
    if(Serial.available()) {
      char ch=char(Serial.read());
      if(ch=='\n') return overflow?line+"!":line;
      if(ch!='\r') {
        if(line.length()<128) line+=ch;
        else overflow=true;
      }
    }
    delay(1);
  }
}
bool validDeviceToken(const String &token) {
  if(token.length()<32||token.length()>128) return false;
  for(size_t i=0;i<token.length();++i) if(token[i]<33||token[i]>126) return false;
  return true;
}
void loadConfiguration() {
  Preferences preferences;
  if(!preferences.begin("tp-cam-link",false)) haltWithMessage("Cannot open device settings storage");
  String ssid=preferences.getString("ssid",deviceWifiSSID);
  String password=preferences.getString("password",deviceWifiPassword);
  String token=preferences.getString("token",deviceToken);
  if(ssid.isEmpty()||ssid.length()>32||password.length()>64||!validDeviceToken(token)) {
    statusScreen("USB setup needed.\nSerial Monitor: 115200\nSet line ending: Newline.");
    Serial.println("ONE-TIME USB SETUP: use 115200 baud and Newline. Inputs are NOT echoed.");
    do { Serial.println("1/3 Send your 2.4 GHz Wi-Fi SSID, then Enter:"); ssid=readSetupLine(); }
    while(ssid.isEmpty()||ssid.length()>32);
    do { Serial.println("2/3 Send Wi-Fi password, then Enter. Send - for an open network:"); password=readSetupLine(); if(password=="-") password=""; }
    while(password.length()>64);
    do { Serial.println("3/3 Send a private random device token (32-128 printable characters, no spaces):"); token=readSetupLine(); }
    while(!validDeviceToken(token));
    bool saved=preferences.putString("ssid",ssid)>0;
    preferences.putString("password",password);
    saved=preferences.isKey("password")&&preferences.getString("password")==password&&saved;
    saved=preferences.putString("token",token)>0&&saved;
    if(!saved) haltWithMessage("Saving device settings failed. Reset and retry.");
    Serial.println("Device settings saved. No credentials were printed.");
  }
  ssid.toCharArray(deviceWifiSSID,sizeof(deviceWifiSSID));
  password.toCharArray(deviceWifiPassword,sizeof(deviceWifiPassword));
  token.toCharArray(deviceToken,sizeof(deviceToken));
  preferences.end();
}

void startCamera() {
  if(!psramFound()) {
    cameraInitResult=ESP_ERR_NO_MEM;
    Serial.println("Camera disabled: PSRAM unavailable; select ESP32 Wrover Module.");
    return;
  }
  camera_config_t config={};
  config.ledc_channel=LEDC_CHANNEL_0; config.ledc_timer=LEDC_TIMER_0;
  config.pin_d0=4; config.pin_d1=5; config.pin_d2=18; config.pin_d3=19;
  config.pin_d4=36; config.pin_d5=39; config.pin_d6=34; config.pin_d7=35;
  config.pin_xclk=21; config.pin_pclk=22; config.pin_vsync=25; config.pin_href=23;
  config.pin_sccb_sda=26; config.pin_sccb_scl=27;
  config.pin_pwdn=-1; config.pin_reset=-1;
  config.xclk_freq_hz=20000000;
  config.pixel_format=PIXFORMAT_JPEG; config.frame_size=FRAMESIZE_QVGA;
  config.jpeg_quality=15; config.fb_count=2;
  config.fb_location=CAMERA_FB_IN_PSRAM; config.grab_mode=CAMERA_GRAB_LATEST;
  cameraInitResult=esp_camera_init(&config);
  cameraReady=cameraInitResult==ESP_OK;
  Serial.printf("Freenove WROVER camera: %s (0x%x)\n",cameraReady?"ready, JPEG 320x240":"FAILED",unsigned(cameraInitResult));
}
bool cameraAuthorized(httpd_req_t *req) {
  char authorization[160];
  size_t length=httpd_req_get_hdr_value_len(req,"Authorization");
  size_t tokenLength=strlen(deviceToken);
  if(length!=tokenLength+7||length>=sizeof(authorization)||
     httpd_req_get_hdr_value_str(req,"Authorization",authorization,sizeof(authorization))!=ESP_OK||
     memcmp(authorization,"Bearer ",7)!=0) return false;
  uint8_t difference=0;
  for(size_t i=0;i<tokenLength;++i) difference|=uint8_t(authorization[i+7])^uint8_t(deviceToken[i]);
  return difference==0;
}
esp_err_t requireCameraAuthorization(httpd_req_t *req) {
  httpd_resp_set_status(req,"401 Unauthorized");
  httpd_resp_set_type(req,"application/json");
  httpd_resp_set_hdr(req,"Cache-Control","no-store");
  httpd_resp_set_hdr(req,"WWW-Authenticate","Bearer");
  return httpd_resp_send(req,"{\"error\":\"auth_required\"}",HTTPD_RESP_USE_STRLEN);
}
esp_err_t cameraUnavailable(httpd_req_t *req) {
  httpd_resp_set_status(req,"503 Service Unavailable");
  httpd_resp_set_type(req,"application/json");
  return httpd_resp_send(req,"{\"error\":\"camera_unavailable\"}",HTTPD_RESP_USE_STRLEN);
}
esp_err_t cameraStatusHandler(httpd_req_t *req) {
  if(!cameraAuthorized(req)) return requireCameraAuthorization(req);
  char out[260];
  snprintf(out,sizeof(out),"{\"camera_available\":%s,\"camera_init_error\":%d,\"width\":320,\"height\":240,\"format\":\"jpeg\",\"target_fps\":5,\"frames_sent\":%lu}",
    cameraReady?"true":"false",int(cameraInitResult),(unsigned long)cameraFrames.load());
  httpd_resp_set_type(req,"application/json"); httpd_resp_set_hdr(req,"Cache-Control","no-store");
  return httpd_resp_send(req,out,HTTPD_RESP_USE_STRLEN);
}
esp_err_t sensorHttpHandler(httpd_req_t *req) {
  if(!cameraAuthorized(req)) return requireCameraAuthorization(req);
  char snapshot[sizeof(sensorCache)];
  portENTER_CRITICAL(&sensorCacheLock); memcpy(snapshot,sensorCache,sizeof(snapshot)); portEXIT_CRITICAL(&sensorCacheLock);
  httpd_resp_set_type(req,"application/json"); httpd_resp_set_hdr(req,"Cache-Control","no-store");
  return httpd_resp_send(req,snapshot,HTTPD_RESP_USE_STRLEN);
}
esp_err_t captureHandler(httpd_req_t *req) {
  if(!cameraAuthorized(req)) return requireCameraAuthorization(req);
  if(!cameraReady) return cameraUnavailable(req);
  camera_fb_t *image=esp_camera_fb_get();
  if(!image) return cameraUnavailable(req);
  httpd_resp_set_type(req,"image/jpeg"); httpd_resp_set_hdr(req,"Cache-Control","no-store");
  esp_err_t result=httpd_resp_send(req,reinterpret_cast<const char *>(image->buf),image->len);
  esp_camera_fb_return(image);
  if(result==ESP_OK) ++cameraFrames;
  return result;
}
esp_err_t streamHandler(httpd_req_t *req) {
  if(!cameraAuthorized(req)) return requireCameraAuthorization(req);
  if(!cameraReady) return cameraUnavailable(req);
  httpd_resp_set_type(req,"multipart/x-mixed-replace; boundary=taskpetframe");
  httpd_resp_set_hdr(req,"Cache-Control","no-store");
  httpd_resp_set_hdr(req,"X-Content-Type-Options","nosniff");
  while(WiFi.status()==WL_CONNECTED) {
    uint32_t started=millis();
    camera_fb_t *image=esp_camera_fb_get();
    if(!image) return ESP_FAIL;
    char header[120];
    int length=snprintf(header,sizeof(header),"\r\n--taskpetframe\r\nContent-Type: image/jpeg\r\nContent-Length: %u\r\n\r\n",unsigned(image->len));
    esp_err_t result=httpd_resp_send_chunk(req,header,length);
    if(result==ESP_OK) result=httpd_resp_send_chunk(req,reinterpret_cast<const char *>(image->buf),image->len);
    esp_camera_fb_return(image); // Always return, including disconnected clients.
    if(result!=ESP_OK) return result;
    ++cameraFrames;
    uint32_t elapsed=millis()-started;
    if(elapsed<CAMERA_INTERVAL_MS) vTaskDelay(pdMS_TO_TICKS(CAMERA_INTERVAL_MS-elapsed));
    else vTaskDelay(1);
  }
  return ESP_FAIL;
}
void startCameraHttp() {
  if(cameraHttp) return;
  httpd_config_t config=HTTPD_DEFAULT_CONFIG();
  config.server_port=8080; config.stack_size=8192;
  config.max_uri_handlers=4; config.max_open_sockets=2;
  config.send_wait_timeout=2; config.recv_wait_timeout=2; config.lru_purge_enable=true;
  esp_err_t error=httpd_start(&cameraHttp,&config);
  if(error!=ESP_OK) { cameraHttp=nullptr; Serial.printf("Camera HTTP server failed: 0x%x\n",unsigned(error)); return; }
  const char *paths[]={"/stream","/capture","/status","/sensors"};
  esp_err_t (*handlers[])(httpd_req_t *)={streamHandler,captureHandler,cameraStatusHandler,sensorHttpHandler};
  for(int i=0;i<4;++i) {
    httpd_uri_t uri={}; uri.uri=paths[i]; uri.method=HTTP_GET; uri.handler=handlers[i];
    if(httpd_register_uri_handler(cameraHttp,&uri)!=ESP_OK) Serial.println("Camera route registration failed");
  }
}

bool due(uint32_t now,uint32_t before,uint32_t interval) {
  return uint32_t(now-before)>=interval;
}
void resetFrame() { frameActive=false; nextRow=0; }
void sendError(uint8_t client,const char *code) {
  char out[96];
  snprintf(out,sizeof(out),"{\"type\":\"error\",\"code\":\"%s\"}",code);
  socketServer.sendTXT(client,out);
}
bool probe(TwoWire &bus,uint8_t address) {
  bus.beginTransmission(address);
  return bus.endTransmission()==0;
}
int readRegister(TwoWire &bus,uint8_t address,uint8_t reg) {
  bus.beginTransmission(address); bus.write(reg);
  if(bus.endTransmission(false)!=0) return -1;
  if(bus.requestFrom(address,uint8_t(1))!=1) return -1;
  return bus.read();
}
void detectSensors() {
  mpuAddress=envAddress=envKind=0;
  imuValid=envValid=false;
  for(uint8_t a:{uint8_t(0x68),uint8_t(0x69)}) {
    if(probe(SensorWire,a)&&mpu.begin(a,&SensorWire)) {
      mpuAddress=a;
      mpu.setAccelerometerRange(MPU6050_RANGE_4_G);
      mpu.setGyroRange(MPU6050_RANGE_500_DEG);
      mpu.setFilterBandwidth(MPU6050_BAND_21_HZ);
      break;
    }
  }
  for(uint8_t a:{uint8_t(0x76),uint8_t(0x77)}) {
    int id=readRegister(SensorWire,a,0xD0);
    if(id==0x60&&bme.begin(a,&SensorWire)) envKind=1;
    else if(id==0x58&&bmp.begin(a,0x58)) envKind=2;
    if(envKind) { envAddress=a; break; }
  }
  Serial.printf("MPU=%s ENV=%s\n",mpuAddress?"detected":"missing",
    envKind==1?"BME280":envKind==2?"BMP280":"missing");
}
void readMotion(uint32_t now) {
  imuValid=false;
  if(!mpuAddress||!probe(SensorWire,mpuAddress)) return;
  sensors_event_t a,g,t;
  if(!mpu.getEvent(&a,&g,&t)) return;
  ax=a.acceleration.x; ay=a.acceleration.y; az=a.acceleration.z;
  gx=g.gyro.x; gy=g.gyro.y; gz=g.gyro.z;
  mpuTemperature=t.temperature;
  float magnitude=sqrtf(ax*ax+ay*ay+az*az);
  imuValid=isfinite(magnitude)&&magnitude>0.1f&&magnitude<45&&
    isfinite(gx)&&isfinite(gy)&&isfinite(gz)&&isfinite(mpuTemperature);
  if(imuValid) {
    rollDeg=atan2f(ay,az)*180.0f/PI;
    pitchDeg=atan2f(-ax,sqrtf(ay*ay+az*az))*180.0f/PI;
    motionTime=now;
  }
}
void readEnvironment(uint32_t now) {
  envValid=false;
  if(!envKind||!probe(SensorWire,envAddress)) return;
  temperatureC=envKind==1?bme.readTemperature():bmp.readTemperature();
  pressureHpa=(envKind==1?bme.readPressure():bmp.readPressure())/100.0f;
  humidityPct=envKind==1?bme.readHumidity():NAN;
  envValid=isfinite(temperatureC)&&isfinite(pressureHpa)&&
    temperatureC>=-40&&temperatureC<=85&&pressureHpa>=300&&pressureHpa<=1100&&
    (envKind!=1||(isfinite(humidityPct)&&humidityPct>=0&&humidityPct<=100));
  if(envValid) envTime=now;
}
void serviceButton(uint32_t now) {
  if(!BUTTON_ENABLED) return;
  static bool rawBefore=HIGH,stable=HIGH;
  static uint32_t changed=0;
  bool raw=digitalRead(BUTTON_PIN);
  if(raw!=rawBefore) { rawBefore=raw; changed=now; }
  if(raw!=stable&&due(now,changed,35)) {
    stable=raw;
    buttonPressed=stable==LOW;
    if(buttonPressed) ++buttonPressCount;
  }
}
// Emit JSON null for invalid values, never NaN (which is not valid JSON).
String numberOrNull(float value,bool valid) {
  return valid&&isfinite(value)?String(value,3):String("null");
}
void sendSensors() {
  uint32_t now=millis();
  String out; out.reserve(1100);
  out="{\"type\":\"sensors\",\"seq\":"+String(++sensorSequence);
  out+=",\"uptime_ms\":"+String(now);
  out+=",\"imu\":{\"present\":"+String(mpuAddress?"true":"false");
  out+=",\"valid\":"+String(imuValid?"true":"false");
  out+=",\"sample_ms\":"+String(imuValid?String(motionTime):String("null"));
  out+=",\"accel_m_s2\":["+numberOrNull(ax,imuValid)+","+numberOrNull(ay,imuValid)+","+numberOrNull(az,imuValid)+"]";
  out+=",\"gyro_rad_s\":["+numberOrNull(gx,imuValid)+","+numberOrNull(gy,imuValid)+","+numberOrNull(gz,imuValid)+"]";
  out+=",\"temperature_c\":"+numberOrNull(mpuTemperature,imuValid);
  out+=",\"roll_deg\":"+numberOrNull(rollDeg,imuValid)+",\"pitch_deg\":"+numberOrNull(pitchDeg,imuValid)+"}";
  out+=",\"environment\":{\"kind\":\""+String(envKind==1?"BME280":envKind==2?"BMP280":"none")+"\"";
  out+=",\"valid\":"+String(envValid?"true":"false");
  out+=",\"sample_ms\":"+String(envValid?String(envTime):String("null"));
  out+=",\"temperature_c\":"+numberOrNull(temperatureC,envValid);
  out+=",\"pressure_hpa\":"+numberOrNull(pressureHpa,envValid);
  out+=",\"humidity_pct\":"+numberOrNull(humidityPct,envValid&&envKind==1)+"}";
  out+=",\"button\":{\"enabled\":"+String(BUTTON_ENABLED?"true":"false");
  out+=",\"pressed\":"+String(buttonPressed?"true":"false")+",\"press_count\":"+String(buttonPressCount)+"}";
  out+=",\"display\":{\"frames\":"+String(frameCount)+",\"last_frame_id\":";
  out+=frameEverShown?String(lastFrameId):String("null");
  out+="},\"camera\":{\"available\":"+String(cameraReady?"true":"false")+",\"frames_sent\":"+String(cameraFrames.load())+"}";
  out+=",\"rssi_dbm\":"+String(WiFi.RSSI())+"}";
  if(out.length()<sizeof(sensorCache)) {
    portENTER_CRITICAL(&sensorCacheLock); memcpy(sensorCache,out.c_str(),out.length()+1); portEXIT_CRITICAL(&sensorCacheLock);
  }
  if(owner>=0) socketServer.sendTXT(uint8_t(owner),out);
}
uint16_t readLE16(const uint8_t *p) { return uint16_t(p[0])|(uint16_t(p[1])<<8); }
uint32_t readLE32(const uint8_t *p) {
  return uint32_t(p[0])|(uint32_t(p[1])<<8)|(uint32_t(p[2])<<16)|(uint32_t(p[3])<<24);
}
void receiveStrip(uint8_t client,const uint8_t *data,size_t length) {
  if(length<12||memcmp(data,"TPX1",4)!=0) { resetFrame(); sendError(client,"bad_header"); return; }
  uint32_t id=readLE32(data+4);
  uint16_t y=readLE16(data+8),rows=readLE16(data+10);
  if(rows==0||rows>MAX_STRIP_ROWS||y>=HEIGHT||uint32_t(y)+rows>HEIGHT||
     length!=12+size_t(rows)*WIDTH*2) {
    resetFrame(); sendError(client,"bad_strip"); return;
  }
  if(y==0) {
    if(frameActive) { resetFrame(); sendError(client,"frame_in_progress"); return; }
    frameActive=true; receivingId=id; nextRow=0;
  }
  if(!frameActive||id!=receivingId||y!=nextRow) {
    resetFrame(); sendError(client,"strip_order"); return;
  }
  memcpy(reinterpret_cast<uint8_t *>(framebuffer)+size_t(y)*WIDTH*2,data+12,length-12);
  nextRow+=rows; stripTime=millis();
  if(nextRow==HEIGHT) {
    uint32_t started=millis();
    tft.drawRGBBitmap(0,0,framebuffer,WIDTH,HEIGHT);
    lastFrameId=id; frameEverShown=true; ++frameCount;
    resetFrame();
    char ack[180];
    snprintf(ack,sizeof(ack),"{\"type\":\"frame_ack\",\"frame_id\":%lu,\"frames\":%lu,\"draw_ms\":%lu,\"uptime_ms\":%lu}",
      (unsigned long)id,(unsigned long)frameCount,(unsigned long)(millis()-started),(unsigned long)millis());
    socketServer.sendTXT(client,ack);
  }
}
bool authorized(const uint8_t *data,size_t length) {
  size_t tokenLength=strlen(deviceToken);
  if(length!=tokenLength+5||memcmp(data,"AUTH ",5)!=0) return false;
  uint8_t difference=0;
  for(size_t i=0;i<tokenLength;++i) difference|=data[i+5]^uint8_t(deviceToken[i]);
  return difference==0;
}
void socketEvent(uint8_t client,WStype_t type,uint8_t *payload,size_t length) {
  if(type==WStype_CONNECTED) {
    if(owner>=0) { sendError(client,"busy"); socketServer.disconnect(client); return; }
    pendingAuth[client]=true; authStarted[client]=millis();
    socketServer.sendTXT(client,"{\"type\":\"hello\",\"protocol\":\"taskpet-link/1\",\"auth_required\":true}");
    return;
  }
  if(type==WStype_DISCONNECTED) {
    pendingAuth[client]=false;
    if(owner==client) { owner=-1; resetFrame(); Serial.println("App disconnected; last image retained"); }
    return;
  }
  if(type==WStype_TEXT) {
    if(owner!=client) {
      if(owner>=0||!pendingAuth[client]||!authorized(payload,length)) {
        sendError(client,"auth_failed"); socketServer.disconnect(client); return;
      }
      owner=client; pendingAuth[client]=false;
      String ready="{\"type\":\"ready\",\"protocol\":\"taskpet-link/1\",\"width\":240,\"height\":320,\"format\":\"rgb565le\",\"max_strip_rows\":16,\"telemetry_hz\":20,\"button_enabled\":false,\"camera\":{\"available\":"+String(cameraReady?"true":"false")+",\"http_port\":8080,\"stream_path\":\"/stream\",\"capture_path\":\"/capture\",\"width\":320,\"height\":240,\"format\":\"mjpeg\"}}";
      socketServer.sendTXT(client,ready);
      Serial.println("App authenticated");
      sendSensors();
    } else if(length==4&&memcmp(payload,"PING",4)==0) {
      socketServer.sendTXT(client,"{\"type\":\"pong\"}");
    } else sendError(client,"unknown_command");
    return;
  }
  if(type==WStype_BIN) {
    if(owner!=client) { sendError(client,"auth_required"); socketServer.disconnect(client); return; }
    receiveStrip(client,payload,length);
  } else if(type==WStype_FRAGMENT_BIN_START||type==WStype_FRAGMENT_TEXT_START||
            type==WStype_FRAGMENT||type==WStype_FRAGMENT_FIN) {
    resetFrame(); sendError(client,"fragmented_message_unsupported"); socketServer.disconnect(client);
  }
}
void statusScreen(const char *line) {
  tft.fillScreen(ST77XX_BLACK); tft.setTextWrap(true); tft.setTextSize(2);
  tft.setTextColor(ST77XX_GREEN); tft.setCursor(12,20); tft.println("TaskPet Link");
  tft.setTextSize(1); tft.setTextColor(ST77XX_WHITE); tft.setCursor(12,60); tft.println(line);
}
void haltWithMessage(const char *message) {
  Serial.println(message); statusScreen(message);
  while(true) delay(1000);
}
void setup() {
  Serial.begin(115200); delay(250);
  Serial.println("\nFreenove WROVER: camera + TaskPet pixels + live sensors. REWIRING REQUIRED.");
  if(TFT_BL>=0) { pinMode(TFT_BL,OUTPUT); digitalWrite(TFT_BL,!BACKLIGHT_ACTIVE_HIGH); }
  if(BUTTON_ENABLED) pinMode(BUTTON_PIN,INPUT_PULLUP);
  SPI.begin(TFT_SCLK,-1,TFT_MOSI,TFT_CS);
  tft.init(WIDTH,HEIGHT,SPI_MODE0); tft.setSPISpeed(TFT_SPI_HZ);
  tft.setRotation(DISPLAY_ROTATION); tft.invertDisplay(DISPLAY_INVERT);
  if(TFT_BL>=0) digitalWrite(TFT_BL,BACKLIGHT_ACTIVE_HIGH);
  framebuffer=static_cast<uint16_t *>(heap_caps_malloc(FRAME_BYTES,MALLOC_CAP_SPIRAM|MALLOC_CAP_8BIT));
  if(!framebuffer) framebuffer=static_cast<uint16_t *>(heap_caps_malloc(FRAME_BYTES,MALLOC_CAP_8BIT));
  if(!framebuffer) haltWithMessage("Framebuffer failed. Select ESP32 Wrover Module / PSRAM.");
  loadConfiguration();
  startCamera(); // Reserve camera SCCB controller before starting sensor bus.
  bool sensorBus=SensorWire.begin(SENSOR_SDA,SENSOR_SCL,100000);
  SensorWire.setTimeOut(25);
  Serial.printf("Shared sensor I2C SDA32/SCL33, controller=%u ready=%d\n",SENSOR_I2C_CONTROLLER,sensorBus); detectSensors();
  readMotion(millis()); readEnvironment(millis());
  sendSensors();
  uint32_t suffix=uint32_t(ESP.getEfuseMac()>>24)&0xFFFFFF;
  char name[32]; snprintf(name,sizeof(name),"taskpet-%06lx",(unsigned long)suffix); hostname=name;
  WiFi.setHostname(name); WiFi.mode(WIFI_STA); WiFi.setSleep(false);
  WiFi.setAutoReconnect(true); WiFi.begin(deviceWifiSSID,deviceWifiPassword);
  statusScreen("Connecting to Wi-Fi...");
  socketServer.begin(); socketServer.onEvent(socketEvent);
  socketServer.enableHeartbeat(10000,3000,2);
  Serial.println("Serial: v diagnostics, i re-detect sensors, x erase Wi-Fi/token and restart. Credentials are never printed.");
}
void loop() {
  uint32_t now=millis();
  static bool wasConnected=false;
  bool connected=WiFi.status()==WL_CONNECTED;
  if(connected&&!wasConnected) {
    startCameraHttp();
    MDNS.end();
    if(MDNS.begin(hostname.c_str())) MDNS.addService("taskpet","tcp",81);
    String address="ws://"+WiFi.localIP().toString()+":81/";
    Serial.println("Connect your app: "+address);
    Serial.println("Also: ws://"+hostname+".local:81/");
    Serial.println("Camera MJPEG: http://"+WiFi.localIP().toString()+":8080/stream (Bearer token required)");
    Serial.println("Camera status/capture and sensor JSON: :8080/status, /capture, /sensors");
    if(!frameEverShown) statusScreen((address+"\n\nWaiting for your app...").c_str());
  }
  if(!connected&&wasConnected) {
    socketServer.disconnect(); owner=-1; resetFrame(); MDNS.end();
    Serial.println("Wi-Fi lost; reconnecting. Last image retained.");
  }
  wasConnected=connected;
  if(!connected&&due(now,lastRetry,30000)) { lastRetry=now; WiFi.reconnect(); }
  if(connected) socketServer.loop();
  now=millis();
  serviceButton(now);
  if(due(now,lastMotion,50)) { lastMotion=now; readMotion(now); }
  if(due(now,lastEnv,1000)) { lastEnv=now; readEnvironment(now); }
  if(due(now,lastTelemetry,50)) { lastTelemetry=now; sendSensors(); }
  if(frameActive&&due(now,stripTime,FRAME_TIMEOUT_MS)) {
    resetFrame(); if(owner>=0) sendError(owner,"frame_timeout");
  }
  for(uint8_t i=0;i<WEBSOCKETS_SERVER_CLIENT_MAX;++i) {
    if(pendingAuth[i]&&due(now,authStarted[i],AUTH_TIMEOUT_MS)) {
      pendingAuth[i]=false; socketServer.disconnect(i);
    }
  }
  if(due(now,lastLog,10000)) {
    lastLog=now;
    Serial.printf("wifi=%s app=%s frames=%lu heap=%u psram=%u imu=%d env=%d\n",
      connected?"up":"down",owner>=0?"connected":"none",(unsigned long)frameCount,
      ESP.getFreeHeap(),ESP.getFreePsram(),imuValid,envValid);
  }
  if(Serial.available()) {
    int command=Serial.read();
    if(command=='i') detectSensors();
    if(command=='v') Serial.printf("IP=%s frames=%lu heap=%u\n",WiFi.localIP().toString().c_str(),(unsigned long)frameCount,ESP.getFreeHeap());
    if(command=='x') {
      Preferences preferences;
      if(preferences.begin("tp-cam-link",false)) { preferences.clear(); preferences.end(); }
      Serial.println("Device settings erased; restarting into USB setup.");
      delay(100); ESP.restart();
    }
  }
  delay(1);
}

