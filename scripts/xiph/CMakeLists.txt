cmake_minimum_required(VERSION 3.30)
project(renderpilot_xiph_adapter LANGUAGES C RC)

include(CheckCCompilerFlag)
include(CheckLinkerFlag)
include(CTest)

set(RENDERPILOT_DOTTED_TRIPLE_PATTERN "^[0-9]+\\.[0-9]+\\.[0-9]+$")
set(RENDERPILOT_DLL_NAME_PATTERN "^[A-Za-z0-9_-]+$")
set(
  RENDERPILOT_WINDOWS_SDK_PATTERN
  "^[0-9]+\\.[0-9]+\\.[0-9]+\\.[0-9]+$"
)
set(RENDERPILOT_GENERATED_DIR "${CMAKE_CURRENT_BINARY_DIR}/generated")
set(
  RENDERPILOT_VERSION_RESOURCE_TEMPLATE
  "${CMAKE_CURRENT_LIST_DIR}/version.rc.in"
)

function(renderpilot_require_nonempty variable_name description)
  if(NOT DEFINED "${variable_name}" OR "${${variable_name}}" STREQUAL "")
    message(FATAL_ERROR "${variable_name} ${description}")
  endif()
endfunction()

function(renderpilot_require_matching variable_name pattern description)
  renderpilot_require_nonempty("${variable_name}" "must be set")

  if(NOT "${${variable_name}}" MATCHES "${pattern}")
    message(FATAL_ERROR "${variable_name} ${description}: '${${variable_name}}'")
  endif()
endfunction()

function(renderpilot_require_directory variable_name description)
  renderpilot_require_nonempty("${variable_name}" "must be set")

  if(NOT IS_DIRECTORY "${${variable_name}}")
    message(
      FATAL_ERROR
      "${variable_name} ${description}: '${${variable_name}}'"
    )
  endif()
endfunction()

function(renderpilot_normalize_boolean variable_name)
  renderpilot_require_nonempty(
    "${variable_name}"
    "must be set to an explicit boolean value"
  )

  string(TOUPPER "${${variable_name}}" normalized_value)
  if(normalized_value MATCHES "^(1|ON|YES|TRUE|Y)$")
    set("${variable_name}" ON PARENT_SCOPE)
  elseif(normalized_value MATCHES "^(0|OFF|NO|FALSE|N)$")
    set("${variable_name}" OFF PARENT_SCOPE)
  else()
    message(
      FATAL_ERROR
      "${variable_name} must be an explicit boolean value, got "
      "'${${variable_name}}'"
    )
  endif()
endfunction()

function(renderpilot_generate_def out_variable source library_name)
  if(NOT EXISTS "${source}")
    message(FATAL_ERROR "Upstream DEF does not exist: ${source}")
  endif()

  file(READ "${source}" definition)
  set(
    library_pattern
    "(^|[\r\n])([ \t]*)LIBRARY([ \t]+[^\r\n]*)?([\r\n]|$)"
  )
  string(REGEX MATCHALL "${library_pattern}" library_directives "${definition}")
  list(LENGTH library_directives library_directive_count)

  if(NOT library_directive_count EQUAL 1)
    message(
      FATAL_ERROR
      "Expected exactly one LIBRARY directive in ${source}, found "
      "${library_directive_count}"
    )
  endif()

  string(
    REGEX REPLACE
    "${library_pattern}"
    "\\1\\2LIBRARY ${library_name}\\4"
    definition
    "${definition}"
  )

  set(output "${RENDERPILOT_GENERATED_DIR}/${library_name}.def")
  file(WRITE "${output}" "${definition}")
  set("${out_variable}" "${output}" PARENT_SCOPE)
endfunction()

function(
  renderpilot_generate_version_resource
  out_variable
  resource_name
  version
  description
  original_filename
)
  string(REPLACE "." ";" version_parts "${version}")
  list(GET version_parts 0 RP_VERSION_MAJOR)
  list(GET version_parts 1 RP_VERSION_MINOR)
  list(GET version_parts 2 RP_VERSION_PATCH)

  set(RP_VERSION "${version}")
  set(RP_DESCRIPTION "${description}")
  set(RP_ORIGINAL_FILENAME "${original_filename}")

  set(output "${RENDERPILOT_GENERATED_DIR}/${resource_name}.rc")
  configure_file("${RENDERPILOT_VERSION_RESOURCE_TEMPLATE}" "${output}" @ONLY)
  set("${out_variable}" "${output}" PARENT_SCOPE)
endfunction()

function(renderpilot_set_runtime_name target output_name)
  set_target_properties(
    "${target}"
    PROPERTIES
      OUTPUT_NAME "${output_name}"
      PREFIX ""
  )
endfunction()

if(NOT MSVC)
  message(FATAL_ERROR "The audited Xiph recipe supports MSVC only")
endif()

renderpilot_require_directory(OGG_ROOT "must point at a prepared source tree")
renderpilot_require_directory(VORBIS_ROOT "must point at a prepared source tree")
renderpilot_require_matching(
  OGG_VERSION
  "${RENDERPILOT_DOTTED_TRIPLE_PATTERN}"
  "must be a dotted triple"
)
renderpilot_require_matching(
  VORBIS_VERSION
  "${RENDERPILOT_DOTTED_TRIPLE_PATTERN}"
  "must be a dotted triple"
)

foreach(output_variable IN ITEMS
    OGG_OUTPUT
    VORBIS_OUTPUT
    VORBISFILE_OUTPUT
    VORBISENC_OUTPUT
)
  renderpilot_require_matching(
    "${output_variable}"
    "${RENDERPILOT_DLL_NAME_PATTERN}"
    "must be a safe DLL base name"
  )
endforeach()

renderpilot_normalize_boolean(XIPH_EMBED_OGG)

if(NOT CMAKE_VS_WINDOWS_TARGET_PLATFORM_VERSION MATCHES
   "${RENDERPILOT_WINDOWS_SDK_PATTERN}")
  message(FATAL_ERROR "CMake did not select an exact Windows SDK version")
endif()

if(NOT EXISTS "${RENDERPILOT_VERSION_RESOURCE_TEMPLATE}")
  message(
    FATAL_ERROR
    "Version resource template does not exist: "
    "${RENDERPILOT_VERSION_RESOURCE_TEMPLATE}"
  )
endif()

file(MAKE_DIRECTORY "${RENDERPILOT_GENERATED_DIR}")
file(
  WRITE
  "${CMAKE_BINARY_DIR}/renderpilot-windows-sdk.txt"
  "${CMAKE_VS_WINDOWS_TARGET_PLATFORM_VERSION}\n"
)

set(CMAKE_C_STANDARD 17)
set(CMAKE_C_STANDARD_REQUIRED ON)
set(CMAKE_C_EXTENSIONS OFF)
set(CMAKE_MSVC_RUNTIME_LIBRARY "MultiThreaded$<$<CONFIG:Debug>:Debug>")

check_c_compiler_flag("/Brepro" RENDERPILOT_HAS_COMPILE_BREPRO)
check_linker_flag(C "/Brepro" RENDERPILOT_HAS_LINK_BREPRO)
if(NOT RENDERPILOT_HAS_COMPILE_BREPRO OR NOT RENDERPILOT_HAS_LINK_BREPRO)
  message(FATAL_ERROR "The selected MSVC toolchain does not support /Brepro")
endif()

add_library(renderpilot_compile_policy INTERFACE)
target_compile_definitions(
  renderpilot_compile_policy
  INTERFACE
    "$<$<COMPILE_LANGUAGE:C>:WIN32_LEAN_AND_MEAN;_CRT_SECURE_NO_WARNINGS;_WIN32_WINNT=0x0A00>"
)
target_compile_options(
  renderpilot_compile_policy
  INTERFACE
    "$<$<COMPILE_LANGUAGE:C>:/O2;/GL;/Gy;/Gw;/GS;/guard:cf;/Brepro>"
)

add_library(renderpilot_link_policy INTERFACE)
target_link_options(
  renderpilot_link_policy
  INTERFACE
    /LTCG
    /OPT:REF
    /OPT:ICF
    /INCREMENTAL:NO
    /DYNAMICBASE
    /NXCOMPAT
    /GUARD:CF
    /Brepro
    "$<$<EQUAL:${CMAKE_SIZEOF_VOID_P},8>:/HIGHENTROPYVA>"
)

renderpilot_generate_version_resource(
  OGG_VERSION_RESOURCE
  ogg
  "${OGG_VERSION}"
  "Xiph.Org libogg runtime"
  "${OGG_OUTPUT}.dll"
)
renderpilot_generate_version_resource(
  VORBIS_VERSION_RESOURCE
  vorbis
  "${VORBIS_VERSION}"
  "Xiph.Org libvorbis runtime"
  "${VORBIS_OUTPUT}.dll"
)
renderpilot_generate_version_resource(
  VORBISFILE_VERSION_RESOURCE
  vorbisfile
  "${VORBIS_VERSION}"
  "Xiph.Org libvorbisfile runtime"
  "${VORBISFILE_OUTPUT}.dll"
)
renderpilot_generate_version_resource(
  VORBISENC_VERSION_RESOURCE
  vorbisenc
  "${VORBIS_VERSION}"
  "Xiph.Org libvorbisenc runtime"
  "${VORBISENC_OUTPUT}.dll"
)

renderpilot_generate_def(OGG_DEF "${OGG_ROOT}/win32/ogg.def" "${OGG_OUTPUT}")
renderpilot_generate_def(
  VORBIS_DEF
  "${VORBIS_ROOT}/win32/vorbis.def"
  "${VORBIS_OUTPUT}"
)
renderpilot_generate_def(
  VORBISFILE_DEF
  "${VORBIS_ROOT}/win32/vorbisfile.def"
  "${VORBISFILE_OUTPUT}"
)
renderpilot_generate_def(
  VORBISENC_DEF
  "${VORBIS_ROOT}/win32/vorbisenc.def"
  "${VORBISENC_OUTPUT}"
)

set(OGG_INCLUDE_DIR "${OGG_ROOT}/include")
set(VORBIS_INCLUDE_DIR "${VORBIS_ROOT}/include")
set(VORBIS_PRIVATE_INCLUDE_DIR "${VORBIS_ROOT}/lib")

set(OGG_SOURCES
  "${OGG_ROOT}/src/bitwise.c"
  "${OGG_ROOT}/src/framing.c"
)
set(VORBIS_SOURCES
  "${VORBIS_ROOT}/lib/analysis.c"
  "${VORBIS_ROOT}/lib/bitrate.c"
  "${VORBIS_ROOT}/lib/block.c"
  "${VORBIS_ROOT}/lib/codebook.c"
  "${VORBIS_ROOT}/lib/envelope.c"
  "${VORBIS_ROOT}/lib/floor0.c"
  "${VORBIS_ROOT}/lib/floor1.c"
  "${VORBIS_ROOT}/lib/info.c"
  "${VORBIS_ROOT}/lib/lookup.c"
  "${VORBIS_ROOT}/lib/lpc.c"
  "${VORBIS_ROOT}/lib/lsp.c"
  "${VORBIS_ROOT}/lib/mapping0.c"
  "${VORBIS_ROOT}/lib/mdct.c"
  "${VORBIS_ROOT}/lib/psy.c"
  "${VORBIS_ROOT}/lib/registry.c"
  "${VORBIS_ROOT}/lib/res0.c"
  "${VORBIS_ROOT}/lib/sharedbook.c"
  "${VORBIS_ROOT}/lib/smallft.c"
  "${VORBIS_ROOT}/lib/synthesis.c"
  "${VORBIS_ROOT}/lib/window.c"
)

# The historical Windows ABI exports the encoder entry points from both
# vorbis.dll and vorbisenc.dll. Compile the implementation once per
# configuration and link the same object files into both public DLLs.
add_library(
  vorbis_encoder_objects
  OBJECT
  "${VORBIS_ROOT}/lib/vorbisenc.c"
)
target_include_directories(
  vorbis_encoder_objects
  PRIVATE
    "${OGG_INCLUDE_DIR}"
    "${VORBIS_INCLUDE_DIR}"
    "${VORBIS_PRIVATE_INCLUDE_DIR}"
)

set(xiph_compile_targets vorbis_encoder_objects)
set(xiph_shared_targets)

if(XIPH_EMBED_OGG)
  add_library(ogg_embedded STATIC ${OGG_SOURCES})
  target_include_directories(ogg_embedded PUBLIC "${OGG_INCLUDE_DIR}")

  set(ogg_link_target ogg_embedded)
  list(APPEND xiph_compile_targets ogg_embedded)
else()
  add_library(
    ogg
    SHARED
    ${OGG_SOURCES}
    "${OGG_DEF}"
    "${OGG_VERSION_RESOURCE}"
  )
  target_include_directories(ogg PUBLIC "${OGG_INCLUDE_DIR}")
  renderpilot_set_runtime_name(ogg "${OGG_OUTPUT}")

  set(ogg_link_target ogg)
  list(APPEND xiph_compile_targets ogg)
  list(APPEND xiph_shared_targets ogg)
endif()

add_library(
  vorbis
  SHARED
  ${VORBIS_SOURCES}
  $<TARGET_OBJECTS:vorbis_encoder_objects>
  "${VORBIS_DEF}"
  "${VORBIS_VERSION_RESOURCE}"
)
target_include_directories(
  vorbis
  PUBLIC
    "${OGG_INCLUDE_DIR}"
    "${VORBIS_INCLUDE_DIR}"
  PRIVATE
    "${VORBIS_PRIVATE_INCLUDE_DIR}"
)
target_link_libraries(vorbis PRIVATE "${ogg_link_target}")
renderpilot_set_runtime_name(vorbis "${VORBIS_OUTPUT}")

add_library(
  vorbisfile
  SHARED
  "${VORBIS_ROOT}/lib/vorbisfile.c"
  "${VORBISFILE_DEF}"
  "${VORBISFILE_VERSION_RESOURCE}"
)
target_include_directories(
  vorbisfile
  PUBLIC
    "${OGG_INCLUDE_DIR}"
    "${VORBIS_INCLUDE_DIR}"
  PRIVATE
    "${VORBIS_PRIVATE_INCLUDE_DIR}"
)
target_link_libraries(vorbisfile PRIVATE vorbis "${ogg_link_target}")
renderpilot_set_runtime_name(vorbisfile "${VORBISFILE_OUTPUT}")

add_library(
  vorbisenc
  SHARED
  $<TARGET_OBJECTS:vorbis_encoder_objects>
  "${VORBISENC_DEF}"
  "${VORBISENC_VERSION_RESOURCE}"
)
target_include_directories(
  vorbisenc
  PUBLIC
    "${OGG_INCLUDE_DIR}"
    "${VORBIS_INCLUDE_DIR}"
  PRIVATE
    "${VORBIS_PRIVATE_INCLUDE_DIR}"
)
target_link_libraries(vorbisenc PRIVATE vorbis "${ogg_link_target}")
renderpilot_set_runtime_name(vorbisenc "${VORBISENC_OUTPUT}")

list(APPEND xiph_compile_targets vorbis vorbisfile vorbisenc)
list(APPEND xiph_shared_targets vorbis vorbisfile vorbisenc)

foreach(target_name IN LISTS xiph_compile_targets)
  target_link_libraries("${target_name}" PRIVATE renderpilot_compile_policy)
endforeach()

foreach(target_name IN LISTS xiph_shared_targets)
  target_link_libraries("${target_name}" PRIVATE renderpilot_link_policy)
endforeach()

if(BUILD_TESTING)
  add_executable(ogg_bitwise_selftest "${OGG_ROOT}/src/bitwise.c")
  target_compile_definitions(ogg_bitwise_selftest PRIVATE _V_SELFTEST)
  target_include_directories(
    ogg_bitwise_selftest
    PRIVATE
      "${OGG_INCLUDE_DIR}"
  )
  add_test(NAME upstream_ogg_bitwise COMMAND ogg_bitwise_selftest)

  add_executable(ogg_framing_selftest "${OGG_ROOT}/src/framing.c")
  target_compile_definitions(ogg_framing_selftest PRIVATE _V_SELFTEST)
  target_include_directories(
    ogg_framing_selftest
    PRIVATE
      "${OGG_INCLUDE_DIR}"
  )
  add_test(NAME upstream_ogg_framing COMMAND ogg_framing_selftest)

  set(xiph_test_targets ogg_bitwise_selftest ogg_framing_selftest)

  if(EXISTS "${VORBIS_ROOT}/test/test.c" AND
     EXISTS "${VORBIS_ROOT}/test/util.c" AND
     EXISTS "${VORBIS_ROOT}/test/write_read.c")
    add_executable(
      upstream_vorbis_roundtrip
      "${VORBIS_ROOT}/test/test.c"
      "${VORBIS_ROOT}/test/util.c"
      "${VORBIS_ROOT}/test/write_read.c"
      "${VORBIS_ROOT}/lib/vorbisfile.c"
    )
    target_compile_definitions(
      upstream_vorbis_roundtrip
      PRIVATE
        _USE_MATH_DEFINES
    )
    target_include_directories(
      upstream_vorbis_roundtrip
      PRIVATE
        "${OGG_INCLUDE_DIR}"
        "${VORBIS_INCLUDE_DIR}"
        "${VORBIS_PRIVATE_INCLUDE_DIR}"
        "${VORBIS_ROOT}/test"
    )
    target_link_libraries(
      upstream_vorbis_roundtrip
      PRIVATE
        vorbis
        "${ogg_link_target}"
    )
    add_test(
      NAME upstream_vorbis_encode_decode_roundtrip
      COMMAND upstream_vorbis_roundtrip
    )
    list(APPEND xiph_test_targets upstream_vorbis_roundtrip)
  endif()

  add_executable(
    encode_decode_roundtrip
    "${CMAKE_CURRENT_LIST_DIR}/roundtrip_test.c"
  )
  target_include_directories(
    encode_decode_roundtrip
    PRIVATE
      "${OGG_INCLUDE_DIR}"
      "${VORBIS_INCLUDE_DIR}"
      "${VORBIS_PRIVATE_INCLUDE_DIR}"
  )
  target_link_libraries(
    encode_decode_roundtrip
    PRIVATE
      vorbisenc
      vorbisfile
      vorbis
      "${ogg_link_target}"
  )
  add_test(
    NAME renderpilot_encode_decode_roundtrip
    COMMAND encode_decode_roundtrip
  )
  list(APPEND xiph_test_targets encode_decode_roundtrip)

  foreach(target_name IN LISTS xiph_test_targets)
    target_link_libraries(
      "${target_name}"
      PRIVATE
        renderpilot_compile_policy
        renderpilot_link_policy
    )
  endforeach()
endif()
