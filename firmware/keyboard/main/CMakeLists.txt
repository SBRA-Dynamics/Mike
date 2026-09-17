# main/secrets.h holds WiFi credentials and the Claude token. It is git-ignored,
# so create it from the template on the first configure.
if(NOT EXISTS "${CMAKE_CURRENT_LIST_DIR}/secrets.h")
    configure_file("${CMAKE_CURRENT_LIST_DIR}/secrets.example.h" "${CMAKE_CURRENT_LIST_DIR}/secrets.h" COPYONLY)
endif()

set(requires esp32_s3_touch_amoled_1_8 lvgl__lvgl esp_wifi esp_netif esp_event nvs_flash esp_http_client esp-tls
             mbedtls esp_driver_usb_serial_jtag usb esp_http_server app_update esp_timer)
if("${IDF_VERSION_MAJOR}" LESS 6)
    list(APPEND requires json)
endif()

idf_component_register(SRCS "claude_usage_main.c" "usage_client.c" "mike_link.c" "keyboard_input.c" "line_editor.c" "ota_server.c"
                       INCLUDE_DIRS "."
                       REQUIRES ${requires})

idf_build_get_property(build_components BUILD_COMPONENTS)
if("lvgl__lvgl" IN_LIST build_components)
    idf_component_get_property(LVGL_LIB lvgl__lvgl COMPONENT_LIB)
    if(TARGET ${LVGL_LIB})
        target_compile_options(${LVGL_LIB} PRIVATE -Wno-error=attributes)
    endif()
endif()
idf_build_get_property(build_components BUILD_COMPONENTS)
if("chmorgan__esp-audio-player" IN_LIST build_components AND "esp_driver_i2s" IN_LIST build_components)
    idf_component_get_property(AUDIO_PLAYER_LIB chmorgan__esp-audio-player COMPONENT_LIB)
    if(TARGET ${AUDIO_PLAYER_LIB})
        target_link_libraries(${AUDIO_PLAYER_LIB} PUBLIC idf::esp_driver_i2s)
    endif()
endif()
