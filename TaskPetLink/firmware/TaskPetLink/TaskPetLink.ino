/* TaskPet Link v1: Wi-Fi display + sensor bridge. No pet or app logic.
   Paste credentials in a local secrets.h copied from secrets.example.h.
   WebSocket: ws://DEVICE_IP:81/ ; first text message: AUTH <device token>
   Raw RGB565 little-endian 240x320 pixels, delivered in ordered strips.
   See PROTOCOL.txt and the dependency-free JavaScript client.
*/
#include <Arduino.h>
#include <SPI.h>
#include <Wire.h>
#include <WiFi.h>
#include <ESPmDNS.h>
#include <WebSocketsServer.h>
#include <Adafruit_GFX.h>
#include <Adafruit_ST7789.h>
#include <Adafruit_MPU6050.h>
#include <Adafruit_BME280.h>
#include <Adafruit_BMP280.h>
#include <esp_heap_caps.h>
#include <math.h>
#include <initializer_list>
#if __has_include("secrets.h")
#include "secrets.h"
#else
#include "secrets.example.h"
#endif

constexpr int TFT_MOSI=23, TFT_SCLK=18, TFT_CS=27, TFT_DC=26, TFT_RST=25, TFT_BL=33;
constexpr int MPU_SDA=21, MPU_SCL=22, ENV_SDA=32, ENV_SCL=19, BUTTON_PIN=13;
constexpr bool BUTTON_ENABLED=false, BACKLIGHT_ACTIVE_HIGH=true;
constexpr uint8_t DISPLAY_ROTATION=0; // Portrait only: 0 or 2.
constexpr bool DISPLAY_INVERT=true;
constexpr uint32_t TFT_SPI_HZ=20000000;
constexpr size_t WIDTH=240, HEIGHT=320, FRAME_BYTES=WIDTH*HEIGHT*2;
constexpr uint16_t MAX_STRIP_ROWS=16;
constexpr uint32_t FRAME_TIMEOUT_MS=2000, AUTH_TIMEOUT_MS=5000;

Adafruit_ST7789 tft(&SPI,TFT_CS,TFT_DC,TFT_RST);
TwoWire EnvWire(1);
Adafruit_MPU6050 mpu;
Adafruit_BME280 bme;
Adafruit_BMP280 bmp(&EnvWire);
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
    if(probe(Wire,a)&&mpu.begin(a,&Wire)) {
      mpuAddress=a;
      mpu.setAccelerometerRange(MPU6050_RANGE_4_G);
      mpu.setGyroRange(MPU6050_RANGE_500_DEG);
      mpu.setFilterBandwidth(MPU6050_BAND_21_HZ);
      break;
    }
  }
  for(uint8_t a:{uint8_t(0x76),uint8_t(0x77)}) {
    int id=readRegister(EnvWire,a,0xD0);
    if(id==0x60&&bme.begin(a,&EnvWire)) envKind=1;
    else if(id==0x58&&bmp.begin(a,0x58)) envKind=2;
    if(envKind) { envAddress=a; break; }
  }
  Serial.printf("MPU=%s ENV=%s\n",mpuAddress?"detected":"missing",
    envKind==1?"BME280":envKind==2?"BMP280":"missing");
}
void readMotion(uint32_t now) {
  imuValid=false;
  if(!mpuAddress||!probe(Wire,mpuAddress)) return;
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
  if(!envKind||!probe(EnvWire,envAddress)) return;
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
  if(owner<0) return;
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
  out+="},\"rssi_dbm\":"+String(WiFi.RSSI())+"}";
  socketServer.sendTXT(uint8_t(owner),out);
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
  size_t tokenLength=strlen(LINK_DEVICE_TOKEN);
  if(length!=tokenLength+5||memcmp(data,"AUTH ",5)!=0) return false;
  uint8_t difference=0;
  for(size_t i=0;i<tokenLength;++i) difference|=data[i+5]^uint8_t(LINK_DEVICE_TOKEN[i]);
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
      String ready="{\"type\":\"ready\",\"protocol\":\"taskpet-link/1\",\"width\":240,\"height\":320,\"format\":\"rgb565le\",\"max_strip_rows\":16,\"telemetry_hz\":20,\"button_enabled\":"+String(BUTTON_ENABLED?"true":"false")+"}";
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
  Serial.println("\nTaskPet Link v1: Wi-Fi pixels + sensors");
  pinMode(TFT_BL,OUTPUT); digitalWrite(TFT_BL,!BACKLIGHT_ACTIVE_HIGH);
  if(BUTTON_ENABLED) pinMode(BUTTON_PIN,INPUT_PULLUP);
  SPI.begin(TFT_SCLK,-1,TFT_MOSI,TFT_CS); // NO MISO19: used by ENV I2C.
  tft.init(WIDTH,HEIGHT,SPI_MODE0); tft.setSPISpeed(TFT_SPI_HZ);
  tft.setRotation(DISPLAY_ROTATION); tft.invertDisplay(DISPLAY_INVERT);
  digitalWrite(TFT_BL,BACKLIGHT_ACTIVE_HIGH);
  framebuffer=static_cast<uint16_t *>(heap_caps_malloc(FRAME_BYTES,MALLOC_CAP_SPIRAM|MALLOC_CAP_8BIT));
  if(!framebuffer) framebuffer=static_cast<uint16_t *>(heap_caps_malloc(FRAME_BYTES,MALLOC_CAP_8BIT));
  if(!framebuffer) haltWithMessage("Framebuffer failed. Select ESP32 Wrover Module / PSRAM.");
  if(!LINK_WIFI_SSID[0]||strlen(LINK_DEVICE_TOKEN)<32||strlen(LINK_DEVICE_TOKEN)>128)
    haltWithMessage("Configure local secrets.h: Wi-Fi and device token (32-128 characters).");
  bool bus0=Wire.begin(MPU_SDA,MPU_SCL,100000);
  bool bus1=EnvWire.begin(ENV_SDA,ENV_SCL,100000);
  Wire.setTimeOut(25); EnvWire.setTimeOut(25);
  Serial.printf("I2C initialized: MPU=%d ENV=%d\n",bus0,bus1); detectSensors();
  readMotion(millis()); readEnvironment(millis());
  uint32_t suffix=uint32_t(ESP.getEfuseMac()>>24)&0xFFFFFF;
  char name[32]; snprintf(name,sizeof(name),"taskpet-%06lx",(unsigned long)suffix); hostname=name;
  WiFi.setHostname(name); WiFi.mode(WIFI_STA); WiFi.setSleep(false);
  WiFi.setAutoReconnect(true); WiFi.begin(LINK_WIFI_SSID,LINK_WIFI_PASSWORD);
  statusScreen("Connecting to Wi-Fi...");
  socketServer.begin(); socketServer.onEvent(socketEvent);
  socketServer.enableHeartbeat(10000,3000,2);
  Serial.println("Serial: v diagnostics, i re-detect sensors. Credentials are never printed.");
}
void loop() {
  uint32_t now=millis();
  static bool wasConnected=false;
  bool connected=WiFi.status()==WL_CONNECTED;
  if(connected&&!wasConnected) {
    MDNS.end();
    if(MDNS.begin(hostname.c_str())) MDNS.addService("taskpet","tcp",81);
    String address="ws://"+WiFi.localIP().toString()+":81/";
    Serial.println("Connect your app: "+address);
    Serial.println("Also: ws://"+hostname+".local:81/");
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
  }
  delay(1);
}
