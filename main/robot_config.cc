#include "robot_config.h"

#include "boards/common/board.h"
#include "settings.h"
#include "system_info.h"

#include <cJSON.h>
#include <esp_log.h>

namespace {
std::string SerializeVoiceLines(const std::vector<RobotVoiceLine>& voice_lines) {
    cJSON* root = cJSON_CreateArray();
    for (const auto& voice_line : voice_lines) {
        cJSON* item = cJSON_CreateObject();
        cJSON_AddStringToObject(item, "trigger", voice_line.trigger.c_str());
        cJSON_AddStringToObject(item, "text", voice_line.text.c_str());
        cJSON_AddItemToArray(root, item);
    }
    char* json_str = cJSON_PrintUnformatted(root);
    std::string result = json_str ? json_str : "[]";
    cJSON_free(json_str);
    cJSON_Delete(root);
    return result;
}

std::vector<RobotVoiceLine> DeserializeVoiceLines(const std::string& json) {
    std::vector<RobotVoiceLine> result;
    cJSON* root = cJSON_Parse(json.c_str());
    if (!cJSON_IsArray(root)) {
        cJSON_Delete(root);
        return result;
    }
    cJSON* item = nullptr;
    cJSON_ArrayForEach(item, root) {
        if (!cJSON_IsObject(item)) continue;
        auto trigger = cJSON_GetObjectItem(item, "trigger");
        auto text = cJSON_GetObjectItem(item, "text");
        RobotVoiceLine line;
        if (cJSON_IsString(trigger)) line.trigger = trigger->valuestring;
        if (cJSON_IsString(text)) line.text = text->valuestring;
        result.push_back(std::move(line));
    }
    cJSON_Delete(root);
    return result;
}

std::string SerializeMovements(const std::vector<RobotMovement>& movements) {
    cJSON* root = cJSON_CreateArray();
    for (const auto& movement : movements) {
        cJSON* item = cJSON_CreateObject();
        cJSON_AddStringToObject(item, "type", movement.type.c_str());
        cJSON_AddStringToObject(item, "name", movement.name.c_str());
        cJSON_AddNumberToObject(item, "duration", movement.duration);
        cJSON_AddItemToArray(root, item);
    }
    char* json_str = cJSON_PrintUnformatted(root);
    std::string result = json_str ? json_str : "[]";
    cJSON_free(json_str);
    cJSON_Delete(root);
    return result;
}

std::vector<RobotMovement> DeserializeMovements(const std::string& json) {
    std::vector<RobotMovement> result;
    cJSON* root = cJSON_Parse(json.c_str());
    if (!cJSON_IsArray(root)) {
        cJSON_Delete(root);
        return result;
    }
    cJSON* item = nullptr;
    cJSON_ArrayForEach(item, root) {
        if (!cJSON_IsObject(item)) continue;
        auto type = cJSON_GetObjectItem(item, "type");
        auto name = cJSON_GetObjectItem(item, "name");
        auto duration = cJSON_GetObjectItem(item, "duration");
        RobotMovement movement;
        if (cJSON_IsString(type)) movement.type = type->valuestring;
        if (cJSON_IsString(name)) movement.name = name->valuestring;
        if (cJSON_IsNumber(duration)) movement.duration = duration->valueint;
        result.push_back(std::move(movement));
    }
    cJSON_Delete(root);
    return result;
}

constexpr const char* TAG = "RobotConfig";
constexpr const char* kRobotConfigNamespace = "robotcfg";
constexpr const char* kDefaultRobotConfigUrl = "https://robotconfig-ndtagy32va-uc.a.run.app";

RobotConfigData ReadConfigFromSettings() {
    Settings settings(kRobotConfigNamespace, false);
    RobotConfigData data;
    data.kid_name = settings.GetString("kid_name");
    data.greeting_mode = settings.GetString("greeting_mode");
    data.config_version = settings.GetInt("config_version", 0);
    data.updated_at = settings.GetString("updated_at");
    data.voice_lines = DeserializeVoiceLines(settings.GetString("voice_lines", "[]"));
    data.movements = DeserializeMovements(settings.GetString("movements", "[]"));
    return data;
}

bool ParseConfigPayload(const std::string& body, RobotConfigData* out_config) {
    cJSON* root = cJSON_Parse(body.c_str());
    if (root == nullptr) {
        ESP_LOGE(TAG, "Failed to parse robot config JSON");
        return false;
    }

    const cJSON* config = cJSON_GetObjectItem(root, "config");
    if (!cJSON_IsObject(config)) {
        ESP_LOGW(TAG, "Robot config response did not contain a config object");
        cJSON_Delete(root);
        return false;
    }

    RobotConfigData parsed;

    const cJSON* kid_name = cJSON_GetObjectItem(config, "kidName");
    if (cJSON_IsString(kid_name)) {
        parsed.kid_name = kid_name->valuestring;
    }

    const cJSON* greeting_mode = cJSON_GetObjectItem(config, "greetingMode");
    if (cJSON_IsString(greeting_mode)) {
        parsed.greeting_mode = greeting_mode->valuestring;
    }

    const cJSON* config_version = cJSON_GetObjectItem(config, "configVersion");
    if (cJSON_IsNumber(config_version)) {
        parsed.config_version = config_version->valueint;
    }

    const cJSON* updated_at = cJSON_GetObjectItem(config, "updatedAt");
    if (cJSON_IsString(updated_at)) {
        parsed.updated_at = updated_at->valuestring;
    }

    const cJSON* voice_lines = cJSON_GetObjectItem(config, "voiceLines");
    if (cJSON_IsArray(voice_lines)) {
        const cJSON* item = nullptr;
        cJSON_ArrayForEach(item, voice_lines) {
            if (!cJSON_IsObject(item)) continue;
            RobotVoiceLine line;
            const cJSON* trigger = cJSON_GetObjectItem(item, "trigger");
            const cJSON* text = cJSON_GetObjectItem(item, "text");
            if (cJSON_IsString(trigger)) line.trigger = trigger->valuestring;
            if (cJSON_IsString(text)) line.text = text->valuestring;
            parsed.voice_lines.push_back(std::move(line));
        }
    }

    const cJSON* movements = cJSON_GetObjectItem(config, "movements");
    if (cJSON_IsArray(movements)) {
        const cJSON* item = nullptr;
        cJSON_ArrayForEach(item, movements) {
            if (!cJSON_IsObject(item)) continue;
            RobotMovement movement;
            const cJSON* type = cJSON_GetObjectItem(item, "type");
            const cJSON* name = cJSON_GetObjectItem(item, "name");
            const cJSON* duration = cJSON_GetObjectItem(item, "duration");
            if (cJSON_IsString(type)) movement.type = type->valuestring;
            if (cJSON_IsString(name)) movement.name = name->valuestring;
            if (cJSON_IsNumber(duration)) movement.duration = duration->valueint;
            parsed.movements.push_back(std::move(movement));
        }
    }

    *out_config = parsed;
    cJSON_Delete(root);
    return true;
}

void SaveConfigToSettings(const RobotConfigData& data) {
    Settings settings(kRobotConfigNamespace, true);
    settings.SetString("kid_name", data.kid_name);
    settings.SetString("greeting_mode", data.greeting_mode);
    settings.SetInt("config_version", data.config_version);
    settings.SetString("updated_at", data.updated_at);
    settings.SetString("voice_lines", SerializeVoiceLines(data.voice_lines));
    settings.SetString("movements", SerializeMovements(data.movements));
}

bool ConfigChanged(const RobotConfigData& old_config, const RobotConfigData& new_config) {
    return old_config.kid_name != new_config.kid_name ||
        old_config.greeting_mode != new_config.greeting_mode ||
        old_config.config_version != new_config.config_version ||
        old_config.updated_at != new_config.updated_at ||
        SerializeVoiceLines(old_config.voice_lines) != SerializeVoiceLines(new_config.voice_lines) ||
        SerializeMovements(old_config.movements) != SerializeMovements(new_config.movements);
}
} // namespace

std::string RobotConfig::GetConfigUrl() {
    Settings settings(kRobotConfigNamespace, false);
    std::string url = settings.GetString("url");
    if (url.empty()) {
        url = kDefaultRobotConfigUrl;
    }
    return url;
}

RobotConfigData RobotConfig::Load() {
    return ReadConfigFromSettings();
}

bool RobotConfig::FetchAndStore(RobotConfigData* out_config, bool* changed) {
    auto& board = Board::GetInstance();
    auto network = board.GetNetwork();
    if (network == nullptr) {
        ESP_LOGE(TAG, "Network is unavailable");
        return false;
    }

    auto previous = ReadConfigFromSettings();
    auto http = network->CreateHttp(0);
    auto mac = SystemInfo::GetMacAddress();
    auto url = GetConfigUrl() + "?mac=" + mac;

    http->SetHeader("Device-Id", mac.c_str());
    http->SetHeader("Client-Id", board.GetUuid().c_str());
    http->SetHeader("Accept", "application/json");

    ESP_LOGI(TAG, "Fetching robot config from %s", url.c_str());
    if (!http->Open("GET", url)) {
        int last_error = http->GetLastError();
        ESP_LOGE(TAG, "Failed to open robot config request, code=0x%x", last_error);
        return false;
    }

    auto status_code = http->GetStatusCode();
    std::string body = http->ReadAll();
    http->Close();

    if (status_code == 404) {
        ESP_LOGW(TAG, "Robot config not found for MAC %s", mac.c_str());
        return false;
    }

    if (status_code != 200) {
        ESP_LOGE(TAG, "Robot config request failed, status=%d body=%s", status_code, body.c_str());
        return false;
    }

    RobotConfigData fetched;
    if (!ParseConfigPayload(body, &fetched)) {
        return false;
    }

    SaveConfigToSettings(fetched);
    bool config_changed = ConfigChanged(previous, fetched);
    ESP_LOGI(TAG, "Robot config fetched: kid_name=%s version=%d changed=%s",
        fetched.kid_name.c_str(), fetched.config_version, config_changed ? "true" : "false");

    if (out_config != nullptr) {
        *out_config = fetched;
    }
    if (changed != nullptr) {
        *changed = config_changed;
    }
    return true;
}
