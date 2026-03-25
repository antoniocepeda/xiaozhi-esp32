#ifndef ROBOT_CONFIG_H
#define ROBOT_CONFIG_H

#include <string>
#include <vector>

struct RobotVoiceLine {
    std::string trigger;
    std::string text;
};

struct RobotMovement {
    std::string type;
    std::string name;
    int duration = 0;
};

struct RobotConfigData {
    std::string kid_name;
    std::string greeting_mode;
    int config_version = 0;
    std::string updated_at;
    std::vector<RobotVoiceLine> voice_lines;
    std::vector<RobotMovement> movements;

    bool IsEmpty() const {
        return kid_name.empty() && greeting_mode.empty() && config_version == 0 && updated_at.empty() && voice_lines.empty() && movements.empty();
    }
};

class RobotConfig {
public:
    static std::string GetConfigUrl();
    static RobotConfigData Load();
    static bool FetchAndStore(RobotConfigData* out_config = nullptr, bool* changed = nullptr);
};

#endif // ROBOT_CONFIG_H
