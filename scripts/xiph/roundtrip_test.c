#include <limits.h>
#include <math.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include <vorbis/vorbisenc.h>
#include <vorbis/vorbisfile.h>

enum
{
  CHANNEL_COUNT = 2,
  SAMPLE_RATE_HZ = 48000,
  TOTAL_FRAME_COUNT = 48000,
  INPUT_CHUNK_FRAME_COUNT = 4096,
  DECODE_BUFFER_SIZE = 4096,
  INITIAL_BUFFER_CAPACITY = 16 * 1024,
  OGG_STREAM_SERIAL = 0x52504C54,
};

static const float VORBIS_QUALITY = 0.4f;
static const double TEST_TONE_HZ = 440.0;
static const double TAU = 6.283185307179586476925286766559;

typedef enum
{
  STATUS_OK = 0,
  STATUS_VORBIS_ENCODER_INIT = 10,
  STATUS_VORBIS_ANALYSIS_INIT = 11,
  STATUS_VORBIS_BLOCK_INIT = 12,
  STATUS_OGG_STREAM_INIT = 13,
  STATUS_VORBIS_HEADERS = 14,
  STATUS_INVALID_HEADERS = 15,
  STATUS_OGG_PACKET = 16,
  STATUS_OGG_PAGE = 17,
  STATUS_ANALYSIS_BUFFER = 18,
  STATUS_BUFFER_OVERFLOW = 20,
  STATUS_OUT_OF_MEMORY = 21,
  STATUS_ANALYSIS_WRITE = 30,
  STATUS_ANALYSIS_FINISH = 31,
  STATUS_VORBIS_ANALYSIS = 32,
  STATUS_VORBIS_BITRATE = 33,
  STATUS_EMPTY_OUTPUT = 40,
  STATUS_VORBIS_FILE_OPEN = 41,
  STATUS_INVALID_FORMAT = 42,
  STATUS_VORBIS_READ = 43,
  STATUS_FRAME_COUNT = 44,
  STATUS_BYTE_COUNT = 45,
} status_code;

typedef struct
{
  unsigned char *data;
  size_t size;
  size_t capacity;
  size_t position;
} byte_buffer;

typedef struct
{
  vorbis_info info;
  vorbis_comment comment;
  vorbis_dsp_state analysis;
  vorbis_block block;
  ogg_stream_state stream;
} encoder_state;

typedef enum
{
  PAGE_MODE_AVAILABLE,
  PAGE_MODE_FLUSH,
} page_mode;

static void byte_buffer_clear(byte_buffer *buffer)
{
  free(buffer->data);
  *buffer = (byte_buffer){0};
}

static status_code byte_buffer_append(byte_buffer *buffer,
                                      const unsigned char *data, size_t size)
{
  if (size > SIZE_MAX - buffer->size)
    return STATUS_BUFFER_OVERFLOW;

  const size_t required = buffer->size + size;
  if (required > buffer->capacity)
  {
    size_t new_capacity =
        buffer->capacity == 0 ? INITIAL_BUFFER_CAPACITY : buffer->capacity;

    while (new_capacity < required)
    {
      if (new_capacity > SIZE_MAX / 2)
      {
        new_capacity = required;
        break;
      }
      new_capacity *= 2;
    }

    unsigned char *new_data = realloc(buffer->data, new_capacity);
    if (new_data == NULL)
      return STATUS_OUT_OF_MEMORY;

    buffer->data = new_data;
    buffer->capacity = new_capacity;
  }

  if (size != 0)
    memcpy(buffer->data + buffer->size, data, size);
  buffer->size = required;
  return STATUS_OK;
}

static status_code write_ogg_pages(ogg_stream_state *stream,
                                   byte_buffer *output, page_mode mode)
{
  ogg_page page;

  for (;;)
  {
    const int result = mode == PAGE_MODE_FLUSH
                           ? ogg_stream_flush(stream, &page)
                           : ogg_stream_pageout(stream, &page);
    if (result == 0)
      return STATUS_OK;
    if (result < 0 || page.header_len <= 0 || page.body_len < 0 ||
        page.header == NULL || (page.body_len > 0 && page.body == NULL))
    {
      return STATUS_OGG_PAGE;
    }

    status_code status = byte_buffer_append(
        output, page.header, (size_t)page.header_len);
    if (status != STATUS_OK)
      return status;

    status = byte_buffer_append(output, page.body, (size_t)page.body_len);
    if (status != STATUS_OK)
      return status;
  }
}

static size_t read_encoded(void *destination, size_t item_size,
                           size_t item_count, void *datasource)
{
  byte_buffer *input = datasource;
  if (destination == NULL || input == NULL || item_size == 0 ||
      item_count == 0 || item_count > SIZE_MAX / item_size ||
      input->position > input->size)
  {
    return 0;
  }

  const size_t available = input->size - input->position;
  const size_t available_items = available / item_size;
  const size_t items_to_read =
      item_count < available_items ? item_count : available_items;
  const size_t bytes_to_read = items_to_read * item_size;

  if (bytes_to_read != 0)
  {
    memcpy(destination, input->data + input->position, bytes_to_read);
    input->position += bytes_to_read;
  }

  return items_to_read;
}

static int seek_encoded(void *datasource, ogg_int64_t offset, int origin)
{
  byte_buffer *input = datasource;
  if (input == NULL)
    return -1;

  size_t base;

  switch (origin)
  {
  case SEEK_SET:
    base = 0;
    break;
  case SEEK_CUR:
    base = input->position;
    break;
  case SEEK_END:
    base = input->size;
    break;
  default:
    return -1;
  }

  if (base > input->size)
    return -1;

  if (offset >= 0)
  {
    const uint64_t distance = (uint64_t)offset;
    if (distance > (uint64_t)(input->size - base))
    {
      return -1;
    }
    input->position = base + (size_t)distance;
    return 0;
  }

  const uint64_t distance = (uint64_t)(-(offset + 1)) + 1;
  if (distance > base)
    return -1;

  input->position = base - (size_t)distance;
  return 0;
}

static int close_encoded(void *datasource)
{
  (void)datasource;
  return 0;
}

static long tell_encoded(void *datasource)
{
  const byte_buffer *input = datasource;
  if (input == NULL)
    return -1L;
  return input->position <= LONG_MAX ? (long)input->position : -1L;
}

static status_code encoder_initialize(encoder_state *encoder)
{
  status_code status = STATUS_OK;

  vorbis_info_init(&encoder->info);
  if (vorbis_encode_init_vbr(&encoder->info, CHANNEL_COUNT, SAMPLE_RATE_HZ,
                             VORBIS_QUALITY) != 0)
  {
    status = STATUS_VORBIS_ENCODER_INIT;
    goto clear_info;
  }

  vorbis_comment_init(&encoder->comment);
  if (vorbis_analysis_init(&encoder->analysis, &encoder->info) != 0)
  {
    status = STATUS_VORBIS_ANALYSIS_INIT;
    goto clear_comment;
  }

  if (vorbis_block_init(&encoder->analysis, &encoder->block) != 0)
  {
    status = STATUS_VORBIS_BLOCK_INIT;
    goto clear_analysis;
  }

  if (ogg_stream_init(&encoder->stream, OGG_STREAM_SERIAL) != 0)
  {
    status = STATUS_OGG_STREAM_INIT;
    goto clear_block;
  }

  return STATUS_OK;

clear_block:
  vorbis_block_clear(&encoder->block);
clear_analysis:
  vorbis_dsp_clear(&encoder->analysis);
clear_comment:
  vorbis_comment_clear(&encoder->comment);
clear_info:
  vorbis_info_clear(&encoder->info);
  return status;
}

static void encoder_clear(encoder_state *encoder)
{
  ogg_stream_clear(&encoder->stream);
  vorbis_block_clear(&encoder->block);
  vorbis_dsp_clear(&encoder->analysis);
  vorbis_comment_clear(&encoder->comment);
  vorbis_info_clear(&encoder->info);
}

static status_code write_vorbis_headers(encoder_state *encoder,
                                        byte_buffer *encoded)
{
  ogg_packet identification;
  ogg_packet comments;
  ogg_packet setup;

  if (vorbis_analysis_headerout(&encoder->analysis, &encoder->comment,
                                &identification, &comments, &setup) != 0)
  {
    return STATUS_VORBIS_HEADERS;
  }

  if (identification.bytes <= 0 || identification.packet == NULL ||
      comments.bytes <= 0 || comments.packet == NULL ||
      setup.bytes <= 0 || setup.packet == NULL)
  {
    return STATUS_INVALID_HEADERS;
  }

  if (ogg_stream_packetin(&encoder->stream, &identification) != 0 ||
      ogg_stream_packetin(&encoder->stream, &comments) != 0 ||
      ogg_stream_packetin(&encoder->stream, &setup) != 0)
  {
    return STATUS_OGG_PACKET;
  }

  return write_ogg_pages(&encoder->stream, encoded, PAGE_MODE_FLUSH);
}

static status_code drain_analysis(encoder_state *encoder,
                                  byte_buffer *encoded,
                                  size_t *packet_count)
{
  for (;;)
  {
    const int block_result =
        vorbis_analysis_blockout(&encoder->analysis, &encoder->block);
    if (block_result == 0)
      break;
    if (block_result != 1)
      return STATUS_VORBIS_ANALYSIS;

    if (vorbis_analysis(&encoder->block, NULL) != 0)
    {
      return STATUS_VORBIS_ANALYSIS;
    }
    if (vorbis_bitrate_addblock(&encoder->block) != 0)
    {
      return STATUS_VORBIS_BITRATE;
    }

    for (;;)
    {
      ogg_packet packet;
      const int packet_result =
          vorbis_bitrate_flushpacket(&encoder->analysis, &packet);
      if (packet_result == 0)
        break;
      if (packet_result != 1)
        return STATUS_VORBIS_BITRATE;

      if (packet.bytes < 0 ||
          (packet.bytes > 0 && packet.packet == NULL) ||
          ogg_stream_packetin(&encoder->stream, &packet) != 0)
      {
        return STATUS_OGG_PACKET;
      }

      ++*packet_count;
      const status_code status = write_ogg_pages(
          &encoder->stream, encoded, PAGE_MODE_AVAILABLE);
      if (status != STATUS_OK)
        return status;
    }
  }

  return STATUS_OK;
}

static void fill_test_signal(float **buffer, int frame_offset,
                             int frame_count)
{
  for (int frame = 0; frame < frame_count; ++frame)
  {
    const int absolute_frame = frame_offset + frame;
    const double phase =
        TAU * TEST_TONE_HZ * (double)absolute_frame / (double)SAMPLE_RATE_HZ;
    const float sample = (float)sin(phase);

    for (int channel = 0; channel < CHANNEL_COUNT; ++channel)
    {
      buffer[channel][frame] = sample;
    }
  }
}

static status_code encode_test_signal(encoder_state *encoder,
                                      byte_buffer *encoded,
                                      size_t *packet_count)
{
  for (int frame_offset = 0; frame_offset < TOTAL_FRAME_COUNT;)
  {
    const int remaining = TOTAL_FRAME_COUNT - frame_offset;
    const int frame_count = remaining < INPUT_CHUNK_FRAME_COUNT
                                ? remaining
                                : INPUT_CHUNK_FRAME_COUNT;

    float **buffer = vorbis_analysis_buffer(&encoder->analysis, frame_count);
    if (buffer == NULL)
      return STATUS_ANALYSIS_BUFFER;

    fill_test_signal(buffer, frame_offset, frame_count);

    if (vorbis_analysis_wrote(&encoder->analysis, frame_count) != 0)
    {
      return STATUS_ANALYSIS_WRITE;
    }

    const status_code status =
        drain_analysis(encoder, encoded, packet_count);
    if (status != STATUS_OK)
      return status;

    /*
     * Keep the fixture multi-page even when a simple tone compresses into a
     * tiny packet set. Historical seekable Vorbisfile readers cannot restart
     * from a stream whose only audio page is also its EOS page.
     */
    const status_code flush_status =
        write_ogg_pages(&encoder->stream, encoded, PAGE_MODE_FLUSH);
    if (flush_status != STATUS_OK)
      return flush_status;

    frame_offset += frame_count;
  }

  if (vorbis_analysis_wrote(&encoder->analysis, 0) != 0)
  {
    return STATUS_ANALYSIS_FINISH;
  }

  const status_code status = drain_analysis(encoder, encoded, packet_count);
  if (status != STATUS_OK)
    return status;

  return write_ogg_pages(&encoder->stream, encoded, PAGE_MODE_FLUSH);
}

static status_code validate_encoded_stream(byte_buffer *encoded)
{
  static const ov_callbacks callbacks = {
      .read_func = read_encoded,
      .seek_func = seek_encoded,
      .close_func = close_encoded,
      .tell_func = tell_encoded,
  };

  encoded->position = 0;

  OggVorbis_File decoded;
  if (ov_open_callbacks(encoded, &decoded, NULL, 0, callbacks) != 0)
  {
    return STATUS_VORBIS_FILE_OPEN;
  }

  status_code status = STATUS_OK;
  const vorbis_info *info = ov_info(&decoded, -1);
  if (info == NULL || info->channels != CHANNEL_COUNT ||
      info->rate != SAMPLE_RATE_HZ)
  {
    status = STATUS_INVALID_FORMAT;
    goto cleanup;
  }

  const ogg_int64_t frame_count = ov_pcm_total(&decoded, -1);
  if (frame_count != TOTAL_FRAME_COUNT)
  {
    fprintf(stderr, "expected %d PCM frames, decoder reported %lld\n",
            TOTAL_FRAME_COUNT, (long long)frame_count);
    status = STATUS_FRAME_COUNT;
    goto cleanup;
  }

  ogg_int64_t decoded_bytes = 0;
  for (;;)
  {
    char pcm[DECODE_BUFFER_SIZE];
    int bitstream = 0;
    const long count =
        ov_read(&decoded, pcm, (int)sizeof(pcm), 0, 2, 1, &bitstream);

    if (count < 0)
    {
      status = STATUS_VORBIS_READ;
      goto cleanup;
    }
    if (count == 0)
      break;
    if (bitstream != 0)
    {
      status = STATUS_INVALID_FORMAT;
      goto cleanup;
    }

    decoded_bytes += count;
  }

  const ogg_int64_t expected_bytes =
      (ogg_int64_t)TOTAL_FRAME_COUNT * CHANNEL_COUNT * 2;
  if (decoded_bytes != expected_bytes)
  {
    fprintf(stderr, "expected %lld decoded bytes, received %lld\n",
            (long long)expected_bytes, (long long)decoded_bytes);
    status = STATUS_BYTE_COUNT;
  }

cleanup:
  ov_clear(&decoded);
  return status;
}

int main(void)
{
  encoder_state encoder;
  byte_buffer encoded = {0};
  size_t packet_count = 0;

  status_code status = encoder_initialize(&encoder);
  if (status != STATUS_OK)
    return (int)status;

  status = write_vorbis_headers(&encoder, &encoded);
  if (status == STATUS_OK)
  {
    status = encode_test_signal(&encoder, &encoded, &packet_count);
  }

  encoder_clear(&encoder);

  if (status == STATUS_OK && (packet_count == 0 || encoded.size == 0))
  {
    status = STATUS_EMPTY_OUTPUT;
  }
  if (status == STATUS_OK)
  {
    status = validate_encoded_stream(&encoded);
  }

  byte_buffer_clear(&encoded);
  return (int)status;
}
